package io.github.flegrear.lvl

import android.app.Application
import android.os.SystemClock
import android.util.Log
import eu.kanade.tachiyomi.createAppModule
import org.koin.core.context.startKoin

/** Process start-up: what Comics extensions read through Injekt (eu.kanade.tachiyomi.AppModule). */
class LvlApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.i("LVL-Startup", "event=application_on_create t_ms=${SystemClock.elapsedRealtime()}")
        startKoin { modules(createAppModule(this@LvlApp)) }
        Log.i("LVL-Startup", "event=application_ready t_ms=${SystemClock.elapsedRealtime()}")
    }
}
