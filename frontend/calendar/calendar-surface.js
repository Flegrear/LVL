// Calendar presentation uses Growie's compact toolbar, a weekly release list
// and hourly grid, and weekday-aligned month cells in LVL's monochrome palette.
import { artworkFallback, escapeHtml, icon } from "../ui/ui.js";

const key = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const fromKey = (value) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
};
const plusDays = (value, count) => {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  date.setDate(date.getDate() + count);
  return date;
};
const monday = (value) => plusDays(value, -(value.getDay() + 6) % 7);
const format = (value, options) => value.toLocaleDateString(undefined, options);
const time = (event) => event.timestamp
  ? format(new Date(event.timestamp), { hour: "2-digit", minute: "2-digit" }) : "Time TBA";
const eventType = (event) => event.type === "movie" ? "MOVIE"
  : event.type === "anime" ? "ANIME" : "SHOW";
const countLabel = (count) => `${count.toLocaleString()} release${count === 1 ? "" : "s"}`;
const localHour = (event) => event.timestamp ? new Date(event.timestamp).getHours() : null;

const poster = (event) => {
  const candidates = [event.thumbnail, event.artwork, event.fallbackArtwork]
    .filter((url, index, all) => /^https:\/\//.test(url || "") && all.indexOf(url) === index);
  const url = candidates[0] || artworkFallback(event.title, { ratio: "poster" });
  return `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-calendar-image-key="${escapeHtml(event.id)}" data-calendar-image-source="${escapeHtml(url)}" data-calendar-image-title="${escapeHtml(event.title)}"${candidates[1] ? ` data-calendar-image-alternate="${escapeHtml(candidates[1])}"` : ""}${candidates[2] ? ` data-calendar-image-last="${escapeHtml(candidates[2])}"` : ""} />`;
};

function agendaItem(event, selected) {
  return `<div class="calendar-list__item${selected === event.id ? " is-selected" : ""}">
    <button type="button" class="calendar-agenda-event" data-calendar-event="${escapeHtml(event.id)}">
      <span class="calendar-agenda-art">${poster(event)}</span>
      <span class="calendar-agenda-info"><strong>${escapeHtml(event.title)}</strong>
        <small>${escapeHtml(event.code || (event.type === "movie" ? "Premiere" : "Episode"))}${event.episodeTitle ? ` - ${escapeHtml(event.episodeTitle)}` : ""}</small>
        <em>${escapeHtml(eventType(event))}${event.inMyList ? " - ON MY LIST" : ""}</em>
      </span>
      <span class="calendar-agenda-time">${escapeHtml(time(event))}</span>
    </button>
  </div>`;
}

function dayStrip(anchor, today, dayCounts) {
  const start = monday(anchor);
  return `<nav class="calendar-date-strip" aria-label="Choose a release date">
    ${Array.from({ length: 14 }, (_, i) => {
      const date = plusDays(start, i);
      const dateKey = key(date);
      const selected = key(anchor) === dateKey;
      const current = key(today) === dateKey;
      return `<button type="button" data-calendar-date="${dateKey}" class="${selected ? "is-selected" : ""}${current ? " is-today" : ""}" aria-pressed="${selected}" aria-label="${escapeHtml(format(date, { weekday: "long", month: "long", day: "numeric" }))}, ${countLabel(dayCounts.get(dateKey) || 0)}">
        <span>${escapeHtml(format(date, { weekday: "short" }))}</span><strong>${date.getDate()}</strong><i aria-hidden="true" class="${current ? "is-today" : dayCounts.get(dateKey) ? "has-releases" : ""}"></i>
      </button>`;
    }).join("")}
  </nav>`;
}

function eventBuckets(events, dateKey) {
  const hours = new Map();
  let untimed = 0;
  for (const event of events) {
    if (event.date !== dateKey) continue;
    const hour = localHour(event);
    if (hour === null) { untimed++; continue; }
    if (!hours.has(hour)) hours.set(hour, []);
    hours.get(hour).push(event);
  }
  return { hours, untimed };
}

function timedColumns(events, dates, today) {
  return `<div class="calendar-time-grid${dates.length > 1 ? " is-week" : ""}" style="--calendar-columns:${dates.length}">
    <div class="calendar-time-axis" aria-hidden="true">${Array.from({ length: 24 }, (_, h) =>
      `<span style="top:${h * 60}px">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>
    <div class="calendar-time-columns">${dates.map((date) => {
      const dateKey = key(date);
      const { hours } = eventBuckets(events, dateKey);
      const nowLine = key(today) === dateKey
        ? `<span class="calendar-now-line" aria-hidden="true" style="top:${today.getHours() * 60 + today.getMinutes()}px"><i></i></span>` : "";
      return `<div class="calendar-time-column${dateKey === key(today) ? " is-today" : ""}">
        ${[...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, rows]) => {
          const first = rows[0];
          return `<div class="calendar-hour-events" style="top:${hour * 60 + 4}px">
            <button type="button" class="calendar-time-event" data-calendar-event="${escapeHtml(first.id)}" aria-label="${escapeHtml(`${first.title} - ${first.code || "Premiere"} - ${time(first)}`)}">
              <span class="calendar-time-event-art">${poster(first)}</span>
              <span class="calendar-time-event-copy"><strong>${escapeHtml(first.title)}</strong><small>${escapeHtml(first.code || "Premiere")}${first.episodeTitle ? ` - ${escapeHtml(first.episodeTitle)}` : ""}</small></span>
            </button>
            ${rows.length > 1 ? `<button type="button" class="calendar-time-more" data-calendar-hour="${dateKey}:${hour}" aria-label="See ${rows.length - 1} more releases at this hour">+${rows.length - 1}</button>` : ""}
          </div>`;
        }).join("")}
        ${nowLine}
      </div>`;
    }).join("")}</div>
  </div>`;
}

function dayView(events, anchor, today, selected, agendaLimit, hourFocus, releaseState, panelWidth) {
  const dateKey = key(anchor);
  const dayEvents = events.filter((event) => event.date === dateKey);
  const agenda = hourFocus === ""
    ? dayEvents : dayEvents.filter((event) => hourFocus === "unknown"
      ? !event.timestamp : localHour(event) === Number(hourFocus));
  const untimed = dayEvents.filter((event) => !event.timestamp).length;
  const label = format(anchor, { month: "long", day: "numeric" });
  return `<div class="calendar-day-layout">
    <aside class="calendar-quest-panel" aria-label="Releases on ${escapeHtml(label)}">
      <header class="calendar-quest-head">
        <div><h3>${escapeHtml(label)}</h3><p>${countLabel(agenda.length)}${hourFocus === "" ? " scheduled" : " at the selected time"}</p></div>
        <span class="calendar-quest-count">${dayEvents.length}</span>
      </header>
      ${hourFocus !== "" ? `<div class="calendar-agenda-filter"><span>${hourFocus === "unknown" ? "No confirmed time" : `${String(hourFocus).padStart(2, "0")}:00`}</span><button type="button" data-calendar-clear-hour>All times</button></div>` : ""}
      <div class="calendar-agenda-list">
        ${agenda.length ? agenda.slice(0, agendaLimit).map((event) => agendaItem(event, selected)).join("")
          : `<div class="calendar-day-empty">${icon("clock")}<span>${releaseState === "loading" ? "Loading release schedules…" : "No releases scheduled"}</span><small>Choose another date or filter.</small></div>`}
        ${agenda.length > agendaLimit ? `<button type="button" data-calendar-more class="calendar-load-more">Show more releases (${agenda.length - agendaLimit} remaining)</button>` : ""}
      </div>
    </aside>
    <button type="button" class="calendar-panel-resizer" data-calendar-resize role="separator" aria-orientation="vertical" aria-label="Resize release list" aria-valuemin="240" aria-valuemax="520" aria-valuenow="${panelWidth}" title="Drag to resize release list"></button>
    <section class="calendar-timeline-pane" aria-label="Hourly release schedule">
      ${untimed ? `<div class="calendar-untimed"><span>${untimed} release${untimed === 1 ? "" : "s"} without a confirmed hour</span><button type="button" data-calendar-hour="${dateKey}:unknown">View</button></div>` : ""}
      <div class="calendar-timeline-scroll">${timedColumns(dayEvents, [anchor], today)}</div>
      ${dayEvents.every((event) => !event.timestamp) ? `<div class="calendar-grid-hint">${releaseState === "loading" ? "Loading timed releases…" : untimed ? "Release hours are unconfirmed. See the release list on the left." : "No timed releases scheduled for this day."}</div>` : ""}
    </section>
  </div>`;
}

function weekView(events, anchor, today, selectedDay, selected, agendaLimit, hourFocus, releaseState, panelWidth) {
  const start = monday(anchor);
  const dates = Array.from({ length: 7 }, (_, i) => plusDays(start, i));
  const weekKeys = new Set(dates.map(key));
  const focusDate = weekKeys.has(selectedDay) ? selectedDay : key(anchor);
  const dayEvents = events.filter((event) => event.date === focusDate);
  const agenda = hourFocus === "" ? dayEvents : dayEvents.filter((event) => hourFocus === "unknown"
    ? !event.timestamp : localHour(event) === Number(hourFocus));
  const label = format(fromKey(focusDate), { weekday: "short", month: "short", day: "numeric" });
  return `<div class="calendar-week-layout">
    <aside class="calendar-quest-panel" aria-label="Releases on ${escapeHtml(label)}">
      <header class="calendar-quest-head"><div><h3>${escapeHtml(label)}</h3><p>${countLabel(agenda.length)}${hourFocus === "" ? " scheduled" : " at the selected time"}</p></div><span class="calendar-quest-count">${dayEvents.length}</span></header>
      ${hourFocus !== "" ? `<div class="calendar-agenda-filter"><span>${hourFocus === "unknown" ? "No confirmed time" : `${String(hourFocus).padStart(2, "0")}:00`}</span><button type="button" data-calendar-clear-hour>All times</button></div>` : ""}
      <div class="calendar-agenda-list">
        ${agenda.length ? agenda.slice(0, agendaLimit).map((event) => agendaItem(event, selected)).join("")
          : `<div class="calendar-day-empty">${icon("clock")}<span>${releaseState === "loading" ? "Loading release schedules…" : "No releases scheduled"}</span><small>Choose another date or filter.</small></div>`}
        ${agenda.length > agendaLimit ? `<button type="button" data-calendar-more class="calendar-load-more">Show more releases (${agenda.length - agendaLimit} remaining)</button>` : ""}
      </div>
    </aside>
    <button type="button" class="calendar-panel-resizer" data-calendar-resize role="separator" aria-orientation="vertical" aria-label="Resize release list" aria-valuemin="240" aria-valuemax="520" aria-valuenow="${panelWidth}" title="Drag to resize release list"></button>
    <section class="calendar-week-view" aria-label="Weekly release schedule">
    <div class="calendar-week-headers"><span></span>${dates.map((date) => {
      const dateKey = key(date);
      const count = events.filter((event) => event.date === dateKey).length;
      return `<button type="button" data-calendar-date="${dateKey}" class="${dateKey === focusDate ? "is-selected" : ""}${dateKey === key(today) ? " is-today" : ""}" aria-label="Select ${escapeHtml(format(date, { weekday: "long", month: "long", day: "numeric" }))}">
        <small>${escapeHtml(format(date, { weekday: "short" }))}</small><strong>${date.getDate()}</strong><i>${count ? countLabel(count) : ""}</i>
      </button>`;
    }).join("")}</div>
    <div class="calendar-week-untimed">${dates.map((date) => {
      const dateKey = key(date);
      const rows = events.filter((event) => event.date === dateKey && !event.timestamp);
      return `<div class="calendar-week-untimed-day">${rows.slice(0, 2).map((event) =>
        `<button type="button" data-calendar-event="${escapeHtml(event.id)}" aria-label="${escapeHtml(`${event.title} - ${event.code || "Premiere"} - Time TBA`)}"><span class="calendar-week-untimed-art">${poster(event)}</span><span class="calendar-week-untimed-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.code || "Premiere")}</small></span></button>`).join("")}
        ${rows.length > 2 ? `<button type="button" class="calendar-week-untimed-more" data-calendar-hour="${dateKey}:unknown">+${rows.length - 2} more</button>` : ""}
      </div>`;
    }).join("")}</div>
    <div class="calendar-timeline-scroll">${timedColumns(events, dates, today)}</div>
    </section>
  </div>`;
}

function monthView(events, month, anchor, today, compact = false) {
  const start = monday(new Date(month.getFullYear(), month.getMonth(), 1, 12));
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
  const last = plusDays(endOfMonth, (7 - endOfMonth.getDay()) % 7);
  const count = Math.round((last - start) / 86400000) + 1;
  const byDate = new Map();
  for (const event of events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }
  return `<div class="calendar-month-view${compact ? " is-compact" : ""}">
    ${compact ? `<h3>${escapeHtml(format(month, { month: "long", year: "numeric" }))}</h3>` : ""}
    <div class="calendar-month-weekdays">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => `<span>${name}</span>`).join("")}</div>
    <div class="calendar-month-cells" style="--calendar-weeks:${count / 7}">${Array.from({ length: count }, (_, i) => {
      const date = plusDays(start, i);
      const dateKey = key(date);
      const rows = byDate.get(dateKey) || [];
      const outside = date.getMonth() !== month.getMonth();
      // Two large posters plus a visible +N affordance fit even in dense weeks.
      const limit = compact ? 0 : 2;
      return `<div class="calendar-month-cell${outside ? " is-outside" : ""}${dateKey === key(anchor) ? " is-selected" : ""}">
        <div class="calendar-month-cell-head">
          <button type="button" data-calendar-date="${dateKey}" class="${dateKey === key(today) ? "is-today" : ""}" aria-label="Select ${escapeHtml(format(date, { weekday: "long", month: "long", day: "numeric" }))}, ${countLabel(rows.length)}">${date.getDate()}</button>
          ${rows.length ? `<button type="button" class="calendar-month-open" data-calendar-open-day="${dateKey}" title="Open week schedule">${compact ? rows.length : icon("chevron-right")}</button>` : ""}
        </div>
        ${limit ? `<div class="calendar-month-events">${rows.slice(0, limit).map((event) =>
          `<button type="button" data-calendar-event="${escapeHtml(event.id)}" aria-label="${escapeHtml(`${event.title} - ${event.code || "Premiere"}`)}"><span class="calendar-month-event-art">${poster(event)}</span><span class="calendar-month-event-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.code || "Premiere")}${event.episodeTitle ? ` - ${escapeHtml(event.episodeTitle)}` : ""}</small></span></button>`).join("")}
          ${rows.length > limit ? `<button type="button" class="calendar-month-more" data-calendar-open-day="${dateKey}">+${rows.length - limit} more</button>` : ""}
        </div>` : `<div class="calendar-mini-dots">${rows.length ? `<i></i>` : ""}</div>`}
      </div>`;
    }).join("")}</div>
  </div>`;
}

function releaseDetails(event, sourceDetail = null, sourceAvailable = false) {
  if (!event) return "";
  return `<aside class="calendar-detail-popover" aria-label="Selected release details">
    <div class="calendar-detail-head"><button type="button" data-calendar-close-detail aria-label="Close details">${icon("close")}</button></div>
    <div class="calendar-detail-title"><div class="calendar-detail-poster">${poster(event)}</div><div><small>${eventType(event)} - ${escapeHtml(event.source || "Catalog")}</small><h3>${escapeHtml(event.title)}</h3><p class="calendar-detail-episode">${escapeHtml(event.code || "")} ${event.episodeTitle ? `- ${escapeHtml(event.episodeTitle)}` : ""}</p></div></div>
    <dl><div><dt>Release date</dt><dd>${escapeHtml(format(fromKey(event.date), { weekday: "short", month: "short", day: "numeric" }))}</dd></div><div><dt>Local time</dt><dd>${escapeHtml(time(event))}</dd></div><div><dt>My list</dt><dd>${event.inMyList ? "Added" : "Not added"}</dd></div></dl>
    ${sourceAvailable ? `<div class="calendar-detail-source"><button type="button" data-calendar-best-source>${sourceDetail ? "Refresh best source" : "Show best source"}</button><p data-calendar-source-result role="status">${escapeHtml(sourceDetail || "")}</p></div>` : ""}
    ${event.seriesKey || event.catalogId ? `<button type="button" class="calendar-detail-open" data-calendar-open-title>View in Library ${icon("arrow-right")}</button>` : ""}
  </aside>`;
}

export function renderCalendarSurface({
  mode, anchor, today, type, scope = "list", events, selected, agendaLimit,
  hourFocus, coverage, releaseState, releaseUpdatedAt, libraryPending,
  indexedSeriesCount, trackedSeriesCount, savedTitleCount = 0, panelWidth = 340, selectedDay = key(anchor),
  sourceDetail = null, sourceAvailable = false,
}) {
  const selectedEvent = events.find((event) => event.id === selected);
  const count = events.length;
  const dateLabel = mode === "week" ? `Week of ${format(monday(anchor), { month: "short", day: "numeric", year: "numeric" })}`
    : format(anchor, { month: "long", year: "numeric" });
  const providerStatus = Object.entries(coverage).map(([name, info]) =>
    `${name} ${info.status === "ok" ? "live" : info.status === "needs_key" ? "needs key" : info.status === "partial" ? "limited" : "offline"}`).join(" - ");
  const listStatus = savedTitleCount
    ? `${savedTitleCount} saved title${savedTitleCount === 1 ? "" : "s"} - ${count ? countLabel(count) : "No matching air dates"} this ${mode}`
    : "Add titles to your Library to see release dates";
  const statusLabel = !savedTitleCount ? listStatus :
    releaseState === "loading" ? `${listStatus} - Loading release schedules…` :
    releaseState === "error" ? `${listStatus} - Schedule unavailable`
      : `${listStatus}${providerStatus ? ` - ${providerStatus}` : ""}`;
  return `<div class="calendar-growie" style="--calendar-panel-width:${Math.max(240, Math.min(520, Number(panelWidth) || 340))}px">
    <header class="calendar-topbar">
      <h2>${escapeHtml(dateLabel)}</h2>
      <div class="calendar-view-tabs" role="group" aria-label="Calendar period">
        ${[["week", "Week"], ["month", "Month"]].map(([value, label]) =>
          `<button type="button" data-calendar-mode="${value}" class="${mode === value ? "is-active" : ""}" aria-pressed="${mode === value}">${label}</button>`).join("")}
      </div>
      <div class="calendar-nav-actions">
        <button type="button" data-calendar-nav="today">Today</button>
        <button type="button" data-calendar-nav="previous" aria-label="Previous ${mode}">${icon("chevron-left")}</button>
        <button type="button" data-calendar-nav="next" aria-label="Next ${mode}">${icon("chevron-right")}</button>
      </div>
    </header>
    <div class="calendar-filters">
      <div class="calendar-filter-buttons" role="group" aria-label="Media type">
        ${[["all", "All"], ["anime", "Anime"], ["movie", "Movies"], ["series", "Shows"]].map(([value, label]) =>
          `<button type="button" data-calendar-type="${value}" class="${type === value ? "is-active" : ""}" aria-pressed="${type === value}">${label}</button>`).join("")}
      </div>
      <span class="calendar-filter-count">${countLabel(count)}</span>
      <button type="button" class="calendar-refresh" data-calendar-retry aria-label="Refresh release schedule" title="${escapeHtml(statusLabel)}">${icon("refresh")}</button>
    </div>
    <div class="calendar-workspace">
      ${mode === "week" ? weekView(events, anchor, today, selectedDay, selected, agendaLimit, hourFocus, releaseState, panelWidth)
        : monthView(events, anchor, anchor, today)}
      ${releaseDetails(selectedEvent, sourceDetail, sourceAvailable)}
    </div>
    <footer class="calendar-status-line" role="status"><span>${escapeHtml(statusLabel)}${libraryPending ? ` - Loaded ${indexedSeriesCount}/${trackedSeriesCount} saved shows` : ""}${releaseUpdatedAt ? ` - Updated ${escapeHtml(format(new Date(releaseUpdatedAt), { hour: "2-digit", minute: "2-digit" }))}` : ""}</span><span>Hover an episode to check torrent sources and reported peers.</span></footer>
    <div class="calendar-torrent-tooltip" role="tooltip" hidden></div>
  </div>`;
}
