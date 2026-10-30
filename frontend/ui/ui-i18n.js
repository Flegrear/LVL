// Explicit interface translations. Learning content is never inferred from text.
import { resolveInterfaceLanguage } from "../../shared/settings/language-settings.js";

const SPANISH = {
  "Replay clip": "Repetir fragmento", "Preparing video clip…": "Preparando fragmento de vídeo…",
  "Open this chapter once to save this line’s timing.": "Abre este capítulo una vez para guardar los tiempos de esta frase.",
  "Saved: {count} subtitle sources": "Guardado: {count} fuentes de subtítulos",
  "{due} to study today, from {cards} cards in {decks} decks": "{due} para estudiar hoy, de {cards} tarjetas en {decks} mazos",
  "from your chapters": "de tus capítulos", "Your videos": "Tus vídeos", "From your videos": "De tus vídeos", "Saved words": "Palabras guardadas",
  "A quick quiz: pick the answer and see right away if it's right.": "Un cuestionario rápido: elige una respuesta y comprueba si es correcta.",
  "Say words you've studied out loud and get feedback from your coach.": "Di en voz alta palabras que estudiaste y recibe comentarios de tu tutor.",
  "Talk with a ChatGPT coach about a topic, by voice.": "Habla por voz con un tutor de ChatGPT sobre un tema.",
  "Keys cleared. OpenSubtitles stays on.": "Claves borradas. OpenSubtitles sigue activo.",
  "Base and target languages must be different.": "El idioma de base y el de aprendizaje deben ser distintos.",
  "Home": "Inicio", "Watch": "Ver", "Library": "Biblioteca", "Study": "Estudiar", "Review": "Repasar", "Tests": "Pruebas", "Settings": "Ajustes",
  "WORKSPACE": "ESPACIO DE TRABAJO", "Primary navigation": "Navegación principal", "Main navigation": "Menú principal",
  "Expand navigation": "Expandir menú", "Collapse navigation": "Contraer menú", "Browse by type": "Explorar por tipo",
  "All": "Todo", "Movies": "Películas", "TV Shows": "Series", "Series": "Series", "Anime": "Anime", "Movie": "Película", "TV": "TV",
  "Search titles": "Buscar títulos", "Shuffle picks": "Mezclar recomendaciones", "Open Library": "Abrir biblioteca", "Featured titles": "Títulos destacados",
  "Add a title": "Añadir un título", "Magnet link": "Enlace magnet", "More library actions": "Más acciones de biblioteca",
  "Play a video file": "Reproducir un archivo de vídeo", "Import a library": "Importar una biblioteca", "Export the library": "Exportar la biblioteca",
  "Filter your library": "Filtrar tu biblioteca", "Sort": "Ordenar", "Recent": "Recientes", "Recently added": "Añadidos recientemente", "Title": "Título",
  "Status": "Estado", "Any": "Cualquiera", "Watching": "Viendo", "Completed": "Completado", "Plan to watch": "Pendiente", "Paused": "En pausa", "Dropped": "Abandonado",
  "Continue watching": "Seguir viendo", "Recommended next": "Qué ver después", "Top picks": "Recomendaciones para ti", "In Library": "En biblioteca", "Add to Library": "Añadir a biblioteca",
  "Target language": "Idioma de aprendizaje", "Decks": "Mazos", "Dictation": "Dictado", "Word lists": "Listas de palabras", "Top words": "Palabras frecuentes",
  "AnkiWeb decks": "Mazos de AnkiWeb", "Import file": "Importar archivo", "Export .apkg": "Exportar .apkg", "Export text": "Exportar texto",
  "Word source": "Origen de palabras", "Most frequent": "Más frecuentes", "From chapters": "De capítulos", "Words": "Palabras", "Phrases": "Frases", "Chapter": "Capítulo",
  "No Library chapters": "No hay capítulos en la biblioteca", "Show": "Mostrar", "New": "Nuevas", "Learning": "Aprendiendo", "Mastered": "Dominadas", "Color subtitles": "Colorear subtítulos",
  "Subtitle learning colors": "Colores de aprendizaje en subtítulos", "Top 100": "100 más frecuentes", "In review": "En repaso", "Due": "Pendientes", "Seen in videos": "Vistas en vídeos",
  "Previous page": "Página anterior", "Next page": "Página siguiente", "Study session": "Sesión de estudio", "‹ Decks": "‹ Mazos", "Cards today": "Tarjetas de hoy",
  "Space": "Espacio", "show": "mostrar", "rate": "calificar", "replay": "repetir", "undo": "deshacer", "decks": "mazos",
  "Review mode": "Modo de repaso", "Quiz": "Cuestionario", "Pronunciation": "Pronunciación", "Conversation": "Conversación",
  "Multiple choice, typing and listening. Answers are shown at the end.": "Opciones, escritura y escucha. Las respuestas se muestran al final.",
  "Test score summary": "Resumen de resultados", "Last": "Último", "Average": "Promedio", "Best": "Mejor", "Tests taken": "Pruebas realizadas", "Scores": "Resultados", "Last 20": "Últimos 20",
  "General": "General", "Playback": "Reproducción", "Coach": "Tutor", "Storage": "Almacenamiento", "Recommendations": "Recomendaciones", "Tracking": "Seguimiento", "Languages": "Idiomas", "I speak": "Hablo", "I'm learning": "Estoy aprendiendo",
  "Interface language": "Idioma de la interfaz", "Automatic - match my base language": "Automático - usar mi idioma", "Base accent": "Acento de mi idioma", "Learning accent": "Acento de aprendizaje",
  "English": "Inglés", "Spanish": "Español", "French": "Francés", "German": "Alemán", "Italian": "Italiano", "Portuguese": "Portugués", "Japanese": "Japonés", "Korean": "Coreano", "Chinese": "Chino", "Russian": "Ruso", "Dutch": "Neerlandés", "Polish": "Polaco", "Turkish": "Turco",
  "Spanish - Neutral": "Español - Neutro", "Spanish - Spain": "Español - España", "Spanish - Argentina": "Español - Argentina",
  "English - United States": "Inglés - Estados Unidos", "English - United Kingdom": "Inglés - Reino Unido", "Portuguese - Brazil": "Portugués - Brasil", "Portuguese - Portugal": "Portugués - Portugal", "French - France": "Francés - Francia", "French - Canada": "Francés - Canadá",
  "Subtitle search": "Búsqueda de subtítulos", "SubDL key": "Clave de SubDL", "Wyzie key": "Clave de Wyzie", "SubSource key": "Clave de SubSource", "Optional": "Opcional", "Save": "Guardar", "Clear keys": "Borrar claves",
  "Conversation coach": "Tutor de conversación", "Check": "Comprobar", "Provider": "Proveedor", "ChatGPT in your browser": "ChatGPT en tu navegador", "Helper folder": "Carpeta del complemento", "Connect": "Conectar", "Install helper": "Instalar complemento", "Setup": "Configuración", "Reload": "Recargar",
  "Artwork": "Imágenes", "Off": "Desactivado", "On": "Activado", "Fetch posters automatically": "Buscar pósteres automáticamente", "Fetch missing posters": "Buscar pósteres que faltan",
  "Refresh": "Actualizar", "Player storage": "Almacenamiento del reproductor", "What player storage is": "Qué es el almacenamiento del reproductor", "Player storage used": "Almacenamiento usado por el reproductor", "Free space now": "Liberar espacio ahora",
  "Saved video fragments": "Fragmentos de vídeo guardados", "What saved video fragments are": "Qué son los fragmentos de vídeo guardados", "Saved video fragments used": "Espacio usado por fragmentos de vídeo", "Anki deck media": "Archivos multimedia de mazos Anki", "What Anki deck media is": "Qué son los archivos multimedia de mazos Anki",
  "Leftover downloads": "Descargas sobrantes", "Downloads from earlier runs that ended without cleaning up. Nothing uses them.": "Descargas de sesiones anteriores que terminaron sin limpiarlas. Ya no se usan.", "Delete leftovers": "Borrar descargas sobrantes",
  "Your ratings": "Tus valoraciones", "None yet": "Aún no hay", "About linking AniList": "Sobre la conexión con AniList", "About linking Letterboxd": "Sobre la conexión con Letterboxd", "User name": "Nombre de usuario", "Not linked": "Sin conectar", "Link": "Conectar", "Sync now": "Sincronizar ahora", "Unlink": "Desconectar", "Import your export": "Importar tus datos exportados",
  "Rated here": "Valorados aquí", "About rating titles here": "Sobre las valoraciones aquí", "Your ratings in this app": "Tus valoraciones en esta aplicación", "Movies and series": "Películas y series", "TMDB key": "Clave de TMDB", "About the TMDB key": "Sobre la clave de TMDB", "Not set": "Sin configurar", "API key or read access token": "Clave API o token de acceso de lectura", "Remove": "Eliminar",
  "This product uses the TMDB API but is not endorsed or certified by TMDB.": "Este producto usa la API de TMDB, pero TMDB no lo avala ni certifica.",
  "Updates": "Actualizaciones", "Update now": "Actualizar ahora", "Update picks": "Actualizar recomendaciones", "About automatic and manual updates": "Sobre las actualizaciones automáticas y manuales", "Automatic or manual": "Automático o manual", "Automatic": "Automático", "Manual": "Manual", "How often": "Frecuencia",
  "Recommendations refresh automatically when you open LVL, at most once per day. Use Update now to refresh anytime.": "Las recomendaciones se actualizan automáticamente al abrir LVL, como máximo una vez al día. Usa Actualizar ahora para actualizar cuando quieras.",
  "See recommendations": "Ver recomendaciones",
  "Every day": "Cada día", "Every 3 days": "Cada 3 días", "Every week": "Cada semana", "Every 2 weeks": "Cada 2 semanas", "Every 30 days": "Cada 30 días", "See your picks": "Ver tus recomendaciones",
  "Your data": "Tus datos", "What the export holds": "Qué contiene la exportación", "Export": "Exportar", "Export all": "Exportar todo", "Export ratings": "Exportar valoraciones", "No hidden titles": "No hay títulos ocultos", "Clear saved details": "Borrar detalles guardados",
  "Close": "Cerrar", "Open a magnet link": "Abrir un enlace magnet", "Open": "Abrir", "Search movies and series": "Buscar películas y series", "Search movies, series and anime": "Buscar películas, series y anime", "Search": "Buscar",
  "SUBTITLE SOURCE / WEB": "FUENTE DE SUBTÍTULOS / WEB", "Find subtitles": "Buscar subtítulos", "Active language pair": "Par de idiomas activo", "Title / release name": "Título / nombre de versión", "Movie or episode title": "Título de película o episodio", "Type": "Tipo", "Season": "Temporada", "Episode": "Episodio", "Search web": "Buscar en la web", "Search more variants": "Buscar más variantes",
  "Live preview": "Vista previa en vivo", "Subtitle appearance": "Apariencia de subtítulos", "Style": "Estilo", "Font": "Fuente", "Sans": "Sin serifas", "Serif": "Con serifas", "Mono": "Monoespaciada", "Weight": "Grosor", "Medium": "Medio", "Bold": "Negrita", "Heavy": "Grueso", "Size": "Tamaño", "Shadow": "Sombra", "None": "Ninguna", "Soft": "Suave", "Strong": "Fuerte", "Text color": "Color del texto", "Subtitle text color": "Color del texto de subtítulos", "Background": "Fondo", "Height": "Altura", "Second language": "Segundo idioma", "Show subtitles": "Mostrar subtítulos", "Latin-alphabet companion": "Transcripción en alfabeto latino", "Show Romanized Text": "Mostrar texto romanizado", "Rotate background colors": "Cambiar colores de fondo", "Customize": "Personalizar", "Reset": "Restablecer", "Done": "Listo",
  "Library file": "Archivo de biblioteca", "A file exported from this app.": "Un archivo exportado de esta aplicación.", "Choose file": "Elegir archivo", "Your anime list, a title per show. Your scores also shape your Top picks.": "Tu lista de anime, con un título por serie. Tus valoraciones también mejoran tus recomendaciones.", "AniList username": "Nombre de usuario de AniList", "Import list": "Importar lista", "Search shared decks": "Buscar mazos compartidos",
  "Decks are shared by the Anki community on ankiweb.net. Downloaded decks are saved in this app's data folder.": "La comunidad de Anki comparte los mazos en ankiweb.net. Los mazos descargados se guardan en la carpeta de datos de esta aplicación.",
  "Title actions": "Acciones del título", "Choose a poster image": "Elegir una imagen de póster", "Find another poster": "Buscar otro póster", "Rename": "Cambiar nombre", "Remove from Library": "Eliminar de la biblioteca",
  "Play": "Reproducir", "Pause": "Pausar", "Replay": "Repetir", "Mute": "Silenciar", "Unmute": "Activar sonido", "Fullscreen": "Pantalla completa", "Exit fullscreen": "Salir de pantalla completa", "Back": "Volver", "Next": "Siguiente", "Previous": "Anterior", "Cancel": "Cancelar", "Retry": "Reintentar", "Loading…": "Cargando…", "Loading": "Cargando", "Checking…": "Comprobando…", "Connected": "Conectado", "Disconnected": "Desconectado",
  "Previous chapter": "Capítulo anterior", "Next chapter": "Capítulo siguiente", "Back 10 seconds": "Retroceder 10 segundos", "Forward 10 seconds": "Avanzar 10 segundos", "Video sources": "Fuentes de vídeo", "Audio track": "Pista de audio", "Torrent transfer totals": "Totales de transferencia del torrent", "Autoplay next episode": "Reproducir automáticamente el siguiente episodio", "Volume": "Volumen", "Loop subtitle line": "Repetir frase de subtítulos", "Picture in picture": "Imagen en imagen", "Playback position": "Posición de reproducción", "Ready to": "Listo para", "downloaded": "descargado",
  "Subtitle line": "Frase de subtítulos", "Go to the previous line ( [ )": "Ir a la frase anterior ( [ )", "Previous line": "Frase anterior", "Hear the current line again ( R )": "Escuchar otra vez la frase actual ( R )", "Replay line": "Repetir frase", "Go to the next line ( ] )": "Ir a la frase siguiente ( ] )", "Next line": "Frase siguiente", "Speed": "Velocidad", "Pause after each line": "Pausar después de cada frase", "Add file": "Añadir archivo", "Sync every track to the audio again": "Volver a sincronizar todas las pistas con el audio", "Appearance": "Apariencia", "In the video file": "En el archivo de vídeo", "lines": "frases", "words": "palabras", "cards": "tarjetas", "Drop .srt or .vtt here.": "Suelta un archivo .srt o .vtt aquí.", "shift timing": "ajustar tiempo",
  "What the timeline shows": "Qué muestra la línea de tiempo",
  "The white part is what you've watched. The light grey part right after it is ready to play without waiting. The faint layer underneath marks the parts of the file already downloaded, wherever they are.": "La parte blanca es lo que has visto. La parte gris clara que sigue está lista para reproducirse sin esperar. La capa tenue inferior marca las partes del archivo ya descargadas, dondequiera que estén.",
  "Seeking inside the light grey part is instant; anywhere else the player loads that part first.": "Moverse dentro de la parte gris clara es instantáneo; fuera de ella el reproductor carga esa parte primero.",
  "How subtitles are synced": "Cómo se sincronizan los subtítulos",
  "Subtitles from inside the video file already match it, so they're used as they are.": "Los subtítulos incluidos en el archivo de vídeo ya coinciden con él y se usan tal como están.",
  "Downloaded or added subtitles are matched to the speech in this video. While it plays, the app listens to the audio that has already played (nothing extra is downloaded), finds when people talk, and moves the subtitle lines until they line up.": "Los subtítulos descargados o añadidos se ajustan al habla del vídeo. Mientras se reproduce, la aplicación escucha el audio ya reproducido (sin descargar nada más), detecta cuándo hablan las personas y mueve las frases hasta que coincidan.",
  "The first match takes about a minute of playback.": "El primer ajuste tarda aproximadamente un minuto de reproducción.",
  "As you keep watching it corrects a fixed delay, a slow drift (a different frame rate) or a jump at a cut such as a recap.": "Mientras sigues viendo, corrige un retraso fijo, un desfase gradual (por otra frecuencia de fotogramas) o un salto en un corte, como un resumen.",
  "A track that isn't matched yet follows one that is, so both languages stay together.": "Una pista aún sin ajustar sigue a otra ya ajustada, para que los dos idiomas se mantengan juntos.",
  "The result is saved for this episode.": "El resultado se guarda para este episodio.", "measures again;": "vuelve a medir;", "move a track by hand.": "mueven una pista manualmente.",
  "Stay signed in to": "Mantén abierta tu sesión en", "in this browser.": "en este navegador.", "Press": "Pulsa", "In Extensions, turn on Developer mode, choose": "En Extensiones, activa el modo de desarrollador, elige", "Load unpacked": "Cargar descomprimida", "and pick the": "y selecciona", "folder.": "como carpeta.", "After an app update, press": "Después de actualizar la aplicación, pulsa", "on the helper in Extensions.": "en el complemento, dentro de Extensiones.",
  "Space for the videos the player downloads from torrents while you watch. Only the file you play is downloaded, a piece at a time.": "Espacio para los vídeos que el reproductor descarga de torrents mientras los ves. Solo se descarga el archivo que reproduces, por partes.",
  "When you switch to another video, the previous download is deleted.": "Al cambiar de vídeo, se borra la descarga anterior.",
  "Downloads you aren't watching are deleted after 30 minutes unused, and when the app starts again.": "Las descargas que no estás viendo se borran tras 30 minutos sin uso y cuando vuelve a iniciarse la aplicación.",
  "If this space fills up, the downloads you used longest ago go first. The video you're watching is never removed.": "Si se llena este espacio, primero se borran las descargas que llevas más tiempo sin usar. Nunca se elimina el vídeo que estás viendo.",
  "A video bigger than this limit can't be played until you raise it.": "Para reproducir un vídeo que supere este límite, debes aumentarlo.",
  "Recommended:": "Recomendado:",
  "Enough for any 1080p movie, or a few episodes at once. 4K movies can be 40 to 80 GB; raise it if you play those. On a nearly full drive the recommendation is at most a quarter of its free space.": "Suficiente para una película en 1080p o varios episodios. Las películas en 4K pueden ocupar de 40 a 80 GB; aumenta el límite si las reproduces. En un disco casi lleno se recomienda como máximo un cuarto del espacio libre.",
  "Short clips of subtitle lines, the audio and a still frame, cut while you watch from the part that already played. Cards use them to replay their line after the video is gone; Dictation uses the rest.": "Fragmentos breves con la frase, el audio y una imagen, extraídos mientras ves una parte ya reproducida. Las tarjetas los usan para repetir su frase cuando el vídeo ya no está; Dictado usa el resto.",
  "A card's clip is kept as long as the card exists.": "El fragmento de una tarjeta se conserva mientras exista la tarjeta.",
  "When this space is full, clips only used for dictation go first, least recently used; then the oldest card clips. A card keeps its text, and its line is saved again the next time you watch that episode.": "Cuando se llena el espacio, primero se borran los fragmentos exclusivos de dictado usados hace más tiempo; después, los más antiguos de tarjetas. La tarjeta conserva su texto y su frase se guarda de nuevo al volver a ver ese episodio.",
  "That holds about": "Esto permite guardar aproximadamente", "lines. The recommendation grows to twice what your cards' clips use, so they always have room.": "frases. La recomendación aumenta hasta el doble de lo que ocupan los fragmentos de tus tarjetas, para que siempre tengan espacio.",
  "Images, audio and fonts of the decks you added from AnkiWeb or imported, kept in the app's data folder so cards look and sound like in Anki. Deleting a deck in Study removes its media.": "Imágenes, audio y fuentes de los mazos añadidos desde AnkiWeb o importados. Se guardan en la carpeta de datos para que las tarjetas se vean y suenen como en Anki. Al eliminar un mazo en Estudiar, se eliminan sus archivos multimedia.",
  "Your anime list from your public AniList profile: scores, and what you completed, are watching, paused or dropped.": "Tu lista de anime de tu perfil público de AniList: valoraciones y lo que has completado, estás viendo, has pausado o abandonado.",
  "Only read: nothing changes on AniList.": "Solo se consulta: no se cambia nada en AniList.",
  "Read again when you update your picks, at most once an hour, or with Sync now.": "Se vuelve a consultar al actualizar tus recomendaciones, como máximo una vez por hora, o con Sincronizar ahora.",
  "Your public profile shows your latest films and ratings. For your whole diary, export your data on letterboxd.com (Settings, Data, Export your data) and import the zip here.": "Tu perfil público muestra tus últimas películas y valoraciones. Para incluir todo tu diario, exporta tus datos en letterboxd.com (Settings, Data, Export your data) e importa aquí el archivo zip.",
  "Stars become 1 to 10: 4½ stars is 9.": "Las estrellas se convierten a una escala de 1 a 10: 4½ estrellas equivalen a 9.",
  "Films count for your picks once a TMDB key is saved.": "Las películas cuentan para tus recomendaciones cuando guardas una clave de TMDB.",
  "Rate any show or movie on its page, from 1 to 10 with up to two decimals. Seasons can have their own rating.": "Valora cualquier serie o película en su página, de 1 a 10 y con hasta dos decimales. Las temporadas pueden tener su propia valoración.",
  "A rating here counts over an imported one for the same title.": "Una valoración hecha aquí tiene prioridad sobre una importada para el mismo título.",
  "Optional. With a free key from The Movie Database, your picks also include movies and series, and your Letterboxd films count.": "Opcional. Con una clave gratuita de The Movie Database, tus recomendaciones incluyen películas y series, y se tienen en cuenta tus películas de Letterboxd.",
  "Sign in at themoviedb.org, open Settings, then API, and request a key for personal use.": "Inicia sesión en themoviedb.org, abre Settings, luego API y solicita una clave para uso personal.",
  "Paste the API key or the API read access token.": "Pega la clave API o el token de acceso de lectura de la API.", "The key stays on this computer and is never exported.": "La clave permanece en este ordenador y nunca se exporta.",
  "Automatic: your picks update on their own this often, and a few minutes after you change your ratings.": "Automático: tus recomendaciones se actualizan con esta frecuencia y unos minutos después de cambiar tus valoraciones.", "Manual: only when you press Update now.": "Manual: solo al pulsar Actualizar ahora.",
  "Either way, what fans recommend is read again after this many days; until then it comes from this computer.": "En ambos casos, las recomendaciones de otros usuarios se vuelven a consultar después de este número de días; hasta entonces se usan las guardadas en este ordenador.",
  "Export all: one JSON file with your ratings, every show by season (score, votes, genres, description, the date it was read, what fans recommend), your picks and hidden titles.": "Exportar todo: un archivo JSON con tus valoraciones, cada serie por temporada (puntuación, votos, géneros, descripción, fecha de consulta y recomendaciones), tus recomendaciones y títulos ocultos.",
  "Export ratings: your ratings as a spreadsheet (CSV).": "Exportar valoraciones: tus valoraciones en una hoja de cálculo (CSV).", "The TMDB key isn't included. Everything is kept in the app's database in the data folder.": "No se incluye la clave de TMDB. Todo se guarda en la base de datos de la aplicación, dentro de la carpeta de datos.",
  "Swap subtitle languages": "Intercambiar idiomas de subtítulos", "Subtitle settings": "Ajustes de subtítulos", "Subtitles": "Subtítulos", "Subtitle tracks": "Pistas de subtítulos", "Audio tracks": "Pistas de audio", "Add subtitles": "Añadir subtítulos", "Resync": "Volver a sincronizar", "Save word": "Guardar palabra", "Save phrase": "Guardar frase", "Vocabulary": "Vocabulario", "From your videos": "De tus vídeos", "Saved words": "Palabras guardadas", "Imported decks": "Mazos importados",
  "Show answer": "Mostrar respuesta", "Again": "Otra vez", "Hard": "Difícil", "Good": "Bien", "Easy": "Fácil", "Undo": "Deshacer", "Study now": "Estudiar ahora", "Start studying": "Empezar a estudiar", "Start quiz": "Empezar cuestionario", "Start test": "Empezar prueba", "Finish": "Terminar", "Check answer": "Comprobar respuesta", "Your answer": "Tu respuesta", "Type your answer": "Escribe tu respuesta", "Correct": "Correcto", "Incorrect": "Incorrecto", "Close enough": "Casi correcto", "Answer": "Respuesta", "Meaning": "Significado", "Word": "Palabra", "Phrase": "Frase", "Listening": "Escucha", "Typing": "Escritura", "Multiple choice": "Opción múltiple",
  "Which line do you hear?": "¿Qué frase escuchas?", "Which word means": "¿Qué palabra significa", "What does this mean?": "¿Qué significa?", "Type the word for": "Escribe la palabra para", "Type the meaning of": "Escribe el significado de", "Type what you hear": "Escribe lo que escuchas", "Listen and type what you hear.": "Escucha y escribe lo que oyes.", "No cards yet": "Aún no hay tarjetas", "No decks yet": "Aún no hay mazos", "No clips yet": "Aún no hay fragmentos", "Nothing due": "No hay tarjetas pendientes", "All done": "Todo listo", "Session complete": "Sesión completada", "Test complete": "Prueba completada", "Try again": "Intentar de nuevo", "Back to decks": "Volver a los mazos", "Back to setup": "Volver a la configuración", "Add": "Añadir", "Added": "Añadido", "Download": "Descargar", "Import": "Importar", "Delete deck": "Eliminar mazo", "Browse decks": "Explorar mazos", "No results": "Sin resultados", "No matching cards": "No hay tarjetas que coincidan",
  "{count} cards": "{count} tarjetas", "{count} titles": "{count} títulos", "{count} words": "{count} palabras", "{count} phrases": "{count} frases", "{count} due": "{count} pendientes", "{count} new": "{count} nuevas", "{count} learning": "{count} aprendiendo", "Quiz score: {correct}/{total}": "Resultado: {correct}/{total}", "Question {current} of {total}": "Pregunta {current} de {total}", "{correct} of {total} correct": "{correct} de {total} correctas", "{count} cards reviewed": "{count} tarjetas repasadas", "{count} cards added": "{count} tarjetas añadidas", "{count} active": "{count} activos",
  "or": "o", "All {language} cards": "Todas las tarjetas de {language}", "Which word completes the line?": "¿Qué palabra completa la frase?", "What does this line mean?": "¿Qué significa esta frase?", "Play line": "Reproducir frase", "Loading saved lines…": "Cargando frases guardadas…", "Not enough translated lines": "No hay suficientes frases traducidas",
  "Listening needs four saved lines with different translations in your current language pair. Watch a chapter with both subtitle languages to save lines.": "La práctica de escucha necesita cuatro frases guardadas con distintas traducciones en tu par de idiomas actual. Mira un capítulo con subtítulos en ambos idiomas para guardar frases.",
  "Video vocabulary": "Vocabulario del vídeo", "No chapters in Library": "No hay capítulos en la biblioteca", "Video unavailable": "Vídeo no disponible", "This line has no saved clip or video source.": "Esta frase no tiene un fragmento guardado ni una fuente de vídeo.", "Loading line…": "Cargando frase…", "Cached results: AnkiWeb is temporarily unavailable.": "Resultados guardados: AnkiWeb no está disponible temporalmente.",
  "Word → meaning": "Palabra → significado", "Meaning → word": "Significado → palabra", "Mixed": "Mixto", "Enter for next, 1–4 to answer": "Enter para continuar, 1–4 para responder", "Right": "Correcto", "Not quite": "No del todo", "Question direction": "Dirección de la pregunta", "Not enough cards to quiz": "No hay suficientes tarjetas para el cuestionario",
  "A quiz needs at least four cards with a meaning. Add Top words or a deck in Study.": "Un cuestionario necesita al menos cuatro tarjetas con significado. Añade palabras frecuentes o un mazo en Estudiar.",
  "Deck": "Mazo", "Card": "Tarjeta", "Suspend": "Suspender", "Suspended": "Suspendidas", "Undo last": "Deshacer última", "New test": "Nueva prueba", "Change setup": "Cambiar configuración", "Chapters": "Capítulos", "Another round": "Otra ronda", "Mix all chapters": "Mezclar todos los capítulos", "This deck is done for today.": "Este mazo está terminado por hoy.", "How well did you remember?": "¿Qué tan bien lo recordaste?",
  "Add the most frequent words, pick a deck from AnkiWeb, or import an Anki file. Words you save while watching land here too.": "Añade las palabras más frecuentes, elige un mazo de AnkiWeb o importa un archivo Anki. Las palabras que guardes al ver vídeos también aparecen aquí.",
  "Pick another target language, or get a deck from AnkiWeb.": "Elige otro idioma de aprendizaje u obtén un mazo de AnkiWeb.", "AnkiWeb didn't answer": "AnkiWeb no respondió", "Try again in a moment.": "Inténtalo de nuevo en un momento.", "No shared decks found": "No se encontraron mazos compartidos", "Try another word, like the language's name.": "Prueba otra palabra, como el nombre del idioma.", "No saved lines yet": "Aún no hay frases guardadas",
  "Nothing to show yet": "Aún no hay nada que mostrar", "Nothing to practice yet": "Aún no hay nada que practicar", "Words and phrases you've studied show up here, with the line they came from.": "Aquí aparecen las palabras y frases que has estudiado, junto con su frase de origen.", "No chapters saved yet": "Aún no hay capítulos guardados", "No sources saved": "No hay fuentes guardadas", "No sources found": "No se encontraron fuentes", "No matches": "Sin coincidencias", "Nothing here yet.": "Aún no hay nada aquí.", "No titles found": "No se encontraron títulos", "Try another title, or its original name.": "Prueba otro título o su nombre original.", "No new recommendations": "No hay recomendaciones nuevas", "Recommendations unavailable": "Recomendaciones no disponibles", "The catalog could not be loaded. Try again from Home.": "No se pudo cargar el catálogo. Inténtalo de nuevo desde Inicio.", "No video files in this torrent": "Este torrent no contiene archivos de vídeo",
  "Details": "Detalles", "Shuffle": "Mezclar", "Resume": "Continuar", "Find sources": "Buscar fuentes", "Find more sources": "Buscar más fuentes", "Find this title": "Buscar este título", "Add the best source": "Añadir la mejor fuente", "Fetch all magnets": "Obtener todos los enlaces magnet", "Go to the Library": "Ir a la biblioteca", "In your Library": "En tu biblioteca", "Upcoming": "Próximamente", "Play again": "Reproducir otra vez", "Practiced": "Practicadas", "Watch the line": "Ver la frase", "Clear": "Borrar", "End conversation": "Terminar conversación", "Reload the extension": "Recargar extensión", "Connecting…": "Conectando…", "Connect the helper": "Conectar complemento",
  "More information": "Más información", "About voice time": "Sobre el tiempo de voz", "How your speech is checked": "Cómo se comprueba tu voz", "About hands-free": "Sobre el modo manos libres", "How the coach connects": "Cómo se conecta el tutor",
  "ChatGPT limits how long voice can run each day. This counts the voice time used from this app in the last 24 hours. 3 hours is a rough guide, not ChatGPT's exact limit.": "ChatGPT limita el tiempo de voz disponible cada día. Esto cuenta el tiempo de voz usado desde esta aplicación durante las últimas 24 horas. Las 3 horas son una referencia aproximada, no el límite exacto de ChatGPT.",
  "Your browser turns what you say into text, and the coach checks that text against the target. It can't score accent or tone.": "Tu navegador convierte tu voz en texto y el tutor compara ese texto con el objetivo. No puede evaluar el acento ni el tono.",
  "After the coach answers, the mic turns on again by itself, so you can keep going without clicking.": "Cuando responde el tutor, el micrófono vuelve a activarse automáticamente para que puedas seguir sin hacer clic.",
};

const en = {};
const es = {};
for (const [source, translated] of Object.entries(SPANISH)) {
  en[source] = source;
  es[source] = translated;
  const upper = source.toUpperCase();
  if (!Object.hasOwn(SPANISH, upper)) {
    en[upper] = upper;
    es[upper] = translated.toUpperCase();
  }
}
for (const [key, source] of Object.entries({
  "nav.home": "Home", "nav.watch": "Watch", "nav.library": "Library", "nav.study": "Study",
  "nav.review": "Review", "nav.tests": "Tests", "nav.settings": "Settings",
})) {
  en[key] = source;
  es[key] = SPANISH[source];
}
export const UI_TRANSLATIONS = Object.freeze({ en: Object.freeze(en), es: Object.freeze(es) });

// Features registered in frontend/features/registry.js add their own strings
// here instead of editing SPANISH above. Core strings always win.
const featureTranslations = { en: {}, es: {} };
export function registerUiTranslations(table = {}) {
  for (const [language, entries] of Object.entries(table || {})) {
    if (!Object.hasOwn(featureTranslations, language) || !entries || typeof entries !== "object") continue;
    for (const [source, translated] of Object.entries(entries)) {
      if (typeof translated !== "string") continue;
      for (const [key, value] of [[source, translated], [source.toUpperCase(), translated.toUpperCase()]]) {
        if (Object.hasOwn(UI_TRANSLATIONS.en, key) || Object.hasOwn(featureTranslations[language], key)) continue;
        featureTranslations[language][key] = value;
        if (!Object.hasOwn(featureTranslations.en, key)) featureTranslations.en[key] = key;
      }
    }
  }
}
function lookupTranslation(locale, key) {
  if (Object.hasOwn(UI_TRANSLATIONS[locale], key)) return UI_TRANSLATIONS[locale][key];
  if (Object.hasOwn(featureTranslations[locale], key)) return featureTranslations[locale][key];
  return undefined;
}
function knownTranslationKey(key) {
  return Object.hasOwn(UI_TRANSLATIONS.en, key) || Object.hasOwn(featureTranslations.en, key);
}

let currentLanguage = "en";
const originalText = new WeakMap();
const originalAttributes = new WeakMap();
const ATTRIBUTES = Object.freeze({
  "data-i18n-title": "title", "data-i18n-aria-label": "aria-label", "data-i18n-placeholder": "placeholder",
  "data-i18n-tooltip": "data-tooltip", "data-i18n-ui-tooltip": "data-ui-tooltip",
});
const SELECTOR = ["[data-i18n]", ...Object.keys(ATTRIBUTES).map((name) => `[${name}]`)].join(",");
const PROTECTED = "iframe,code,pre,script,style,textarea,[data-i18n-ignore],[data-card-content]";

/** Translate an explicit UI key/source. Escape the result when inserting it into HTML. */
export function t(key, params = {}, language = currentLanguage) {
  const source = String(key ?? "");
  const locale = resolveInterfaceLanguage(language);
  const message = lookupTranslation(locale, source) ?? lookupTranslation("en", source) ?? source;
  return message.replace(/\{([\w]+)\}/g, (placeholder, name) => Object.hasOwn(params || {}, name) ? String(params[name]) : placeholder);
}

function paramsFor(node) {
  try { return JSON.parse(node.getAttribute("data-i18n-params") || "{}"); } catch { return {}; }
}

function englishOriginal(value, key, params) {
  const english = t(key, params, "en");
  return value.trim() === t(key, params, "es") && english !== value.trim()
    ? value.replace(value.trim(), () => english) : value;
}

/** Only explicit UI annotations are visited; direct text changes retain child markup. */
export function translateUi(root = globalThis.document, language = currentLanguage) {
  if (!root) return root;
  const locale = resolveInterfaceLanguage(language);
  const nodes = [...(root.matches?.(SELECTOR) ? [root] : []), ...(root.querySelectorAll?.(SELECTOR) || [])];
  for (const node of nodes) {
    if (node.closest?.(PROTECTED)) continue;
    const params = paramsFor(node);
    const key = node.getAttribute("data-i18n");
    if (key && knownTranslationKey(key)) {
      const texts = [...(node.childNodes || [])].filter((child) => child.nodeType === 3 && child.nodeValue.trim());
      // Mixed prose belongs in separately annotated spans; a label may have icons/counts.
      if (texts.length === 1) {
        const text = texts[0];
        const remembered = originalText.get(text);
        if (!remembered || remembered.key !== key) originalText.set(text, { key, value: englishOriginal(text.nodeValue, key, params) });
        const original = originalText.get(text).value;
        const translated = locale === "en" && !node.hasAttribute("data-i18n-params") ? original : original.replace(original.trim(), () => t(key, params, locale));
        if (text.nodeValue !== translated) text.nodeValue = translated;
      }
    }
    for (const [annotation, attr] of Object.entries(ATTRIBUTES)) {
      const attrKey = node.getAttribute(annotation);
      if (!attrKey || !knownTranslationKey(attrKey)) continue;
      let originals = originalAttributes.get(node);
      if (!originals) { originals = {}; originalAttributes.set(node, originals); }
      if (!originals[attr] || originals[attr].key !== attrKey) originals[attr] = { key: attrKey, value: englishOriginal(node.getAttribute(attr) || t(attrKey, params, "en"), attrKey, params) };
      const translated = locale === "en" && !node.hasAttribute("data-i18n-params") ? originals[attr].value : t(attrKey, params, locale);
      if (node.getAttribute(attr) !== translated) node.setAttribute(attr, translated);
    }
  }
  return root;
}

export function setInterfaceLanguage(preference = "auto", { baseLanguage = "EN", root = globalThis.document } = {}) {
  currentLanguage = resolveInterfaceLanguage(preference, baseLanguage);
  const html = root?.documentElement || (root?.tagName === "HTML" ? root : root?.ownerDocument?.documentElement);
  html?.setAttribute("lang", currentLanguage);
  translateUi(root, currentLanguage);
  return currentLanguage;
}

/** Annotated inserted UI is translated automatically; text mutations cannot retrigger it. */
export function installUiI18n({ root = globalThis.document, interfaceLanguage = "auto", baseLanguage = "EN" } = {}) {
  let language = setInterfaceLanguage(interfaceLanguage, { baseLanguage, root });
  const Observer = root?.defaultView?.MutationObserver || root?.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver;
  const observer = Observer && root ? new Observer((records) => {
    for (const record of records) {
      if (record.target?.matches?.(SELECTOR)) translateUi(record.target, language);
      for (const added of record.addedNodes || []) if (added.nodeType === 1) translateUi(added, language);
    }
  }) : null;
  observer?.observe(root.documentElement || root, { childList: true, subtree: true });
  return {
    setLanguage(preference, nextBaseLanguage = baseLanguage) {
      baseLanguage = nextBaseLanguage;
      language = setInterfaceLanguage(preference, { baseLanguage, root });
      return language;
    },
    translate(target = root) { return translateUi(target, language); },
    t(key, params = {}) { return t(key, params, language); },
    destroy() { observer?.disconnect(); },
  };
}
