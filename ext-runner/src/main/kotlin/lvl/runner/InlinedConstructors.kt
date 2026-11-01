package lvl.runner

// LVL's extension runner. keiyoushi builds extensions with R8,
// which inlines simple constructors in DEX: "new-instance X" is followed by a call to
// X's superclass constructor (often Object.<init>) and X's own constructor may be gone.
// Android's runtime accepts that; the JVM doesn't, and dex2jar turns it into
// "new Object", which fails ("Cannot cast java.lang.Object to b0").
//
// Before conversion this reader repoints such calls to X.<init> with the same
// parameters, and adds that constructor (it only calls the superclass's) to X and to
// any class between X and the called one that lacks it. The inlined body (field
// writes) stays at the call site, as R8 left it.
//
// The same happens inside constructors: with a middle class's constructor removed,
// C.<init> calls its grandparent's constructor on `this` ("Bad <init> method call",
// Asmodeus Scans). That call is repointed to C's direct superclass, which gets the
// constructor it lacks.

import com.googlecode.d2j.DexConstants
import com.googlecode.d2j.Method
import com.googlecode.d2j.reader.BaseDexFileReader
import com.googlecode.d2j.reader.DexFileReader
import com.googlecode.d2j.reader.Op
import com.googlecode.d2j.visitors.DexClassVisitor
import com.googlecode.d2j.visitors.DexCodeVisitor
import com.googlecode.d2j.visitors.DexFileVisitor
import com.googlecode.d2j.visitors.DexMethodVisitor

class InlinedConstructorReader(
    private val reader: BaseDexFileReader,
) : BaseDexFileReader by reader {
    // created: the new instance's class, or (superCall) the class whose constructor makes the call.
    private class Call(
        val created: String,
        val owner: String,
        val params: List<String>,
        val superCall: Boolean = false,
    )

    private class Plan(
        // (class whose constructor to call instead, the called constructor's class, parameter types)
        val retarget: Set<Triple<String, String, List<String>>>,
        // class -> [(superclass to call, parameter types)] constructors to add
        val add: Map<String, List<Pair<String, List<String>>>>,
        val supers: Map<String, String?>,
    )

    // The class whose constructor a call should go to: the new instance's, or the direct superclass's.
    private fun startOf(
        call: Call,
        supers: Map<String, String?>,
    ): String? = if (call.superCall) supers[call.created] else call.created

    @Volatile private var plan: Plan? = null

    // Watches "new-instance" registers in one method and reports init calls on them; in a
    // constructor, also a call on `this` to a constructor above the direct superclass.
    private open class Tracker(
        next: DexCodeVisitor?,
        private val owner: String = "",
        method: Method? = null,
        isStatic: Boolean = true,
    ) : DexCodeVisitor(next) {
        private val created = HashMap<Int, String>()
        private val constructor = method?.name == "<init>" && !isStatic
        private val insWords = if (method == null) 0 else (if (isStatic) 0 else 1) + method.parameterTypes.sumOf { if (it == "J" || it == "D") 2 else 1 }
        private var thisRegister = -1

        open fun onInit(call: Call): Method? = null

        // `this` is the first parameter register: the last insWords registers hold the parameters.
        override fun visitRegister(total: Int) {
            if (constructor) thisRegister = total - insWords
            super.visitRegister(total)
        }

        override fun visitTypeStmt(
            op: Op,
            a: Int,
            b: Int,
            type: String,
        ) {
            if (op == Op.NEW_INSTANCE) created[a] = type else created.remove(a)
            super.visitTypeStmt(op, a, b, type)
        }

        override fun visitMethodStmt(
            op: Op,
            args: IntArray,
            method: Method,
        ) {
            var target = method
            if ((op == Op.INVOKE_DIRECT || op == Op.INVOKE_DIRECT_RANGE) && method.name == "<init>" && args.isNotEmpty()) {
                val type = created.remove(args[0])
                if (type != null && type != method.owner) {
                    onInit(Call(type, method.owner, method.parameterTypes.toList()))?.let { target = it }
                } else if (type == null && constructor && args[0] == thisRegister && method.owner != owner) {
                    onInit(Call(owner, method.owner, method.parameterTypes.toList(), superCall = true))?.let { target = it }
                }
            }
            super.visitMethodStmt(op, args, target)
        }
    }

    private fun analyze(config: Int): Plan {
        val supers = HashMap<String, String?>()
        val ctors = HashMap<String, MutableSet<List<String>>>()
        val calls = ArrayList<Call>()
        reader.accept(
            object : DexFileVisitor() {
                override fun visit(
                    access: Int,
                    className: String,
                    superClass: String?,
                    interfaces: Array<String>?,
                ): DexClassVisitor {
                    supers[className] = superClass
                    return object : DexClassVisitor() {
                        override fun visitMethod(
                            access: Int,
                            method: Method,
                        ): DexMethodVisitor {
                            if (method.name == "<init>") ctors.getOrPut(className) { HashSet() }.add(method.parameterTypes.toList())
                            val isStatic = access and DexConstants.ACC_STATIC != 0
                            return object : DexMethodVisitor() {
                                override fun visitCode(): DexCodeVisitor =
                                    object : Tracker(null, className, method, isStatic) {
                                        override fun onInit(call: Call): Method? {
                                            calls.add(call)
                                            return null
                                        }
                                    }
                            }
                        }
                    }
                }
            },
            config,
        )
        val retarget = HashSet<Triple<String, String, List<String>>>()
        val add = HashMap<String, MutableList<Pair<String, List<String>>>>()
        for (call in calls) {
            val start = startOf(call, supers) ?: continue
            // The classes from the start up to (not including) the called constructor's class.
            val chain = ArrayList<String>()
            var current: String? = start
            while (current != null && current != call.owner && current in supers && chain.size < 32) {
                chain.add(current)
                current = supers[current]
            }
            if (current != call.owner || chain.isEmpty()) continue
            retarget.add(Triple(start, call.owner, call.params))
            for (type in chain) {
                val has = ctors.getOrPut(type) { HashSet() }
                if (call.params in has) continue
                has.add(call.params)
                add.getOrPut(type) { ArrayList() }.add(supers[type]!! to call.params)
            }
        }
        return Plan(retarget, add, supers)
    }

    private fun planFor(config: Int): Plan = plan ?: analyze(config or DexFileReader.SKIP_DEBUG).also { plan = it }

    // A constructor that only calls the superclass's: this in v0, parameters after it.
    private fun addConstructor(
        visitor: DexClassVisitor,
        owner: String,
        superClass: String,
        params: List<String>,
    ) {
        val method = Method(owner, "<init>", params.toTypedArray(), "V")
        val methodVisitor = visitor.visitMethod(DexConstants.ACC_PUBLIC or DexConstants.ACC_CONSTRUCTOR or DexConstants.ACC_SYNTHETIC, method) ?: return
        val code = methodVisitor.visitCode()
        if (code != null) {
            val registers = 1 + params.sumOf { if (it == "J" || it == "D") 2 else 1 }
            code.visitRegister(registers)
            code.visitMethodStmt(
                if (registers > 5) Op.INVOKE_DIRECT_RANGE else Op.INVOKE_DIRECT,
                IntArray(registers) { it },
                Method(superClass, "<init>", params.toTypedArray(), "V"),
            )
            code.visitStmt0R(Op.RETURN_VOID)
            code.visitEnd()
        }
        methodVisitor.visitEnd()
    }

    private fun rewriter(
        next: DexFileVisitor,
        plan: Plan,
    ): DexFileVisitor =
        object : DexFileVisitor(next) {
            override fun visit(
                access: Int,
                className: String,
                superClass: String?,
                interfaces: Array<String>?,
            ): DexClassVisitor? {
                val classVisitor = super.visit(access, className, superClass, interfaces) ?: return null
                return object : DexClassVisitor(classVisitor) {
                    override fun visitMethod(
                        access: Int,
                        method: Method,
                    ): DexMethodVisitor? {
                        val methodVisitor = super.visitMethod(access, method) ?: return null
                        val isStatic = access and DexConstants.ACC_STATIC != 0
                        return object : DexMethodVisitor(methodVisitor) {
                            override fun visitCode(): DexCodeVisitor? {
                                val code = super.visitCode() ?: return null
                                return object : Tracker(code, className, method, isStatic) {
                                    override fun onInit(call: Call): Method? {
                                        val start = startOf(call, plan.supers) ?: return null
                                        return if (Triple(start, call.owner, call.params) in plan.retarget) {
                                            Method(start, "<init>", call.params.toTypedArray(), "V")
                                        } else {
                                            null
                                        }
                                    }
                                }
                            }
                        }
                    }

                    override fun visitEnd() {
                        plan.add[className]?.forEach { (parent, params) -> addConstructor(classVisitor, className, parent, params) }
                        super.visitEnd()
                    }
                }
            }
        }

    override fun accept(visitor: DexFileVisitor) = accept(visitor, 0)

    override fun accept(
        visitor: DexFileVisitor,
        config: Int,
    ) = reader.accept(rewriter(visitor, planFor(config)), config)

    override fun accept(
        visitor: DexFileVisitor,
        classIdx: Int,
        config: Int,
    ) = reader.accept(rewriter(visitor, planFor(config)), classIdx, config)

    // How many calls were repointed and constructors added (for the log and tests).
    fun summary(): Pair<Int, Int> = planFor(0).let { it.retarget.size to it.add.values.sumOf { list -> list.size } }
}
