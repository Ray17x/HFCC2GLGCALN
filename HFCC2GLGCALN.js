// ==UserScript==
// @name         HFCC CALENDER SYNC!! 1.1
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Pull HFCC due dates and sync to Google Calendar (UI + Google connect)
// @author       Steve7108
// @match        https://online.hfcc.edu/course/view.php?id=*
// @match        https://online.hfcc.edu/course/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // Safe wrappers for GM_* (work with/without grants)
    const GM = {
        get: typeof GM_getValue === 'function' ? GM_getValue : (key, def) => Promise.resolve(def),
        set: typeof GM_setValue === 'function' ? GM_setValue : (key, val) => Promise.resolve(),
        menu: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : () => {},
        addStyle:
            typeof GM_addStyle === 'function'
                ? GM_addStyle
                : (css) => {
                      const s = document.createElement('style');
                      s.textContent = css;
                      document.head.appendChild(s);
                  },
    };

    const DEFAULTS = {
        googleClientId: '',
        calendarId: '',
        redirectUri: '',
        highlight: true,
        highlightColor: '#fffa90',
    };

    // --- Styles ---
    GM.addStyle(`
        .hfcc-panel {
            position: fixed;
            right: 16px;
            bottom: 16px;
            width: 340px;
            background: #fff;
            border: 1px solid #ccc;
            box-shadow: 0 6px 18px rgba(0,0,0,0.15);
            z-index: 999999;
            font-family: Arial, Helvetica, sans-serif;
            color: #222;
            padding: 12px;
            border-radius: 6px;
        }
        .hfcc-panel h4 { margin: 0 0 8px 0; font-size: 14px; }
        .hfcc-panel label { display:block; margin:6px 0 2px 0; font-size:12px; }
        .hfcc-panel input[type=text], .hfcc-panel select { width:100%; box-sizing:border-box; padding:6px; font-size:13px; }
        .hfcc-panel .row { display:flex; gap:8px; margin-top:8px; }
        .hfcc-panel button { padding:8px 10px; font-size:13px; cursor:pointer; }
        .hfcc-panel .small { font-size:11px; color:#555; }
        .hfcc-toggle { display:flex; align-items:center; gap:8px; }
    `);

    async function init() {
        const clientId = await GM.get('googleClientId', DEFAULTS.googleClientId);
        const calendarId = await GM.get('calendarId', DEFAULTS.calendarId);
        const redirectUri = await GM.get('redirectUri', DEFAULTS.redirectUri);
        const highlight = await GM.get('highlight', DEFAULTS.highlight);

        injectPanel({ clientId, calendarId, redirectUri, highlight });

        GM.menu('HFCC Calendar Sync — Open Settings', () => {
            const panel = document.querySelector('.hfcc-panel');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
    }

    function injectPanel({ clientId, calendarId, redirectUri, highlight }) {
        if (document.querySelector('.hfcc-panel')) return;

        const panel = document.createElement('div');
        panel.className = 'hfcc-panel';

        panel.innerHTML = `
            <h4>HFCC → Google Calendar</h4>
            <label>Google OAuth Client ID</label>
            <input id="hfcc-client-id" type="text" placeholder="Enter OAuth Client ID" value="${escapeHtml(clientId)}" />
            <div class="small">Create an OAuth Client ID (Web) in Google Cloud Console. Add this origin as an Authorized JavaScript origin.</div>
            <label>Redirect URI</label>
            <input id="hfcc-redirect-uri" type="text" placeholder="https://online.hfcc.edu/" value="${escapeHtml(redirectUri || '')}" />
            <div class="small">Add the exact redirect URI you registered in Google Cloud Console (include trailing slash if you registered it).</div>
            <label>Target Calendar</label>
            <select id="hfcc-calendar-select"><option value="">(not connected)</option></select>
            <div class="row">
                <button id="hfcc-connect">Connect Google</button>
                <button id="hfcc-list-calendars">List Calendars</button>
                <button id="hfcc-sync">Sync due dates</button>
                <button id="hfcc-create-events">Create events</button>
            </div>
            <label class="hfcc-toggle"><input type="checkbox" id="hfcc-highlight" ${highlight ? 'checked' : ''} /> Highlight due dates</label>
            <div class="small" style="margin-top:8px">Status: <span id="hfcc-status">idle</span></div>
        `;

        document.body.appendChild(panel);

        // Wire up events
        panel.querySelector('#hfcc-client-id').addEventListener('change', async (e) => {
            await GM.set('googleClientId', e.target.value.trim());
            setStatus('Saved client id');
        });

        panel.querySelector('#hfcc-redirect-uri').addEventListener('change', async (e) => {
            await GM.set('redirectUri', e.target.value.trim());
            setStatus('Saved redirect uri');
        });

        panel.querySelector('#hfcc-highlight').addEventListener('change', async (e) => {
            await GM.set('highlight', e.target.checked);
            setStatus('Saved highlight');
        });

        panel.querySelector('#hfcc-connect').addEventListener('click', () => connectGoogle());
        panel.querySelector('#hfcc-list-calendars').addEventListener('click', () => listCalendars());
        panel.querySelector('#hfcc-sync').addEventListener('click', () => syncDueDates());
    panel.querySelector('#hfcc-create-events').addEventListener('click', () => createEventsFromParsed());

        loadStoredToken();
    }

    function setStatus(text) {
        const el = document.getElementById('hfcc-status');
        if (el) el.textContent = text;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&"'<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Store token in memory + optionally in GM storage
    let tokenState = null;

    async function loadStoredToken() {
        const raw = await GM.get('googleToken', null);
        if (raw) {
            try {
                tokenState = JSON.parse(raw);
                setStatus('Token loaded');
                // populate calendars if token valid
                await listCalendars();
            } catch (e) {
                console.warn('Failed parse token', e);
            }
        }
    }

    // --- OAuth connect (popup implicit flow) ---
    async function connectGoogle() {
        const clientId = document.getElementById('hfcc-client-id').value.trim();
        if (!clientId) return setStatus('Set Client ID first');

        const scopes = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
        const storedRedirect = await GM.get('redirectUri', '');
        const redirectUri = storedRedirect && storedRedirect.length ? storedRedirect : window.location.origin + '/';
        const state = Math.random().toString(36).slice(2);
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scopes.join(' '))}&state=${encodeURIComponent(state)}`;

        console.log('HFCC Calendar Sync authUrl:', authUrl);
        setStatus('Opening auth popup... (redirect: ' + redirectUri + ')');

        // Open popup and monitor for redirect with token in fragment
        const popup = window.open(authUrl, 'hfcc_google_auth', 'width=600,height=700');
        if (!popup) return setStatus('Popup blocked');

        const poll = setInterval(() => {
            try {
                if (!popup || popup.closed) {
                    clearInterval(poll);
                    setStatus('Popup closed');
                    return;
                }
                const href = popup.location.href;
                if (href && href.indexOf(redirectUri) === 0) {
                    // got redirect to our origin; extract hash
                    const hash = popup.location.hash;
                    if (hash) {
                        const params = parseHash(hash.substring(1));
                        if (params.access_token) {
                            tokenState = {
                                access_token: params.access_token,
                                token_type: params.token_type,
                                expires_in: parseInt(params.expires_in || '0', 10),
                                obtained_at: Date.now(),
                            };
                            GM.set('googleToken', JSON.stringify(tokenState));
                            setStatus('Connected');
                            clearInterval(poll);
                            popup.close();
                            listCalendars();
                        } else {
                            setStatus('Auth failed');
                            clearInterval(poll);
                            popup.close();
                        }
                    }
                }
            } catch (err) {
                // cross-origin until redirected to our origin — ignore
            }
        }, 500);
    }

    function parseHash(hash) {
        return hash.split('&').reduce((acc, pair) => {
            const [k, v] = pair.split('=');
            acc[decodeURIComponent(k)] = decodeURIComponent(v || '');
            return acc;
        }, {});
    }

    async function listCalendars() {
        if (!tokenState) return setStatus('Not connected');
        setStatus('Listing calendars...');
        try {
            const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
                headers: { Authorization: 'Bearer ' + tokenState.access_token },
            });
            if (res.status === 401) {
                setStatus('Token expired or unauthorized');
                return;
            }
            const data = await res.json();
            const sel = document.getElementById('hfcc-calendar-select');
            sel.innerHTML = '';
            data.items.forEach((c) => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.summary + (c.primary ? ' (primary)' : '');
                sel.appendChild(opt);
            });
            setStatus('Calendars loaded');
        } catch (e) {
            console.error(e);
            setStatus('Failed listing');
        }
    }

    async function syncDueDates() {
        const results = await scanForCloses();
        console.group('HFCC Calendar Sync — container scan');
        console.log('Results found:', results.length);
        console.log(results.slice(0, 100));
        console.groupEnd();

        showParsedResults(results);
        setStatus('Scan complete: ' + results.length + ' items found in containers');
    }

    async function scanForCloses() {
        setStatus('Scanning activity containers for Closes/Closed labels...');

        const containerSelectors = ['.activity', '.modtype_assign', '.assignment', '.activityinstance', '.instancename', '.activityinstance', '.mod-indent-outer', '.course-content'];
        const containers = Array.from(document.querySelectorAll(containerSelectors.join(',')));

        // If no containers found, fallback to scanning sections that commonly hold assignments
        if (containers.length === 0) {
            containers.push(...Array.from(document.querySelectorAll('.course, .region-main, .content')));
        }

        const results = [];

        // Regex to find month name + day + year and optional time
    const dateRegex = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\w\s,.]*?\d{1,2},?\s*\d{4}(?:[,\s]*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?/i;
    // labels we care about: Closes, Closed, Due, Opens (allow optional colon)
    const labelRegex = /\b(Closes?|Closed|Due|Opens?)[:]?/i;

        for (const c of containers) {
            try {
                const text = c.textContent || '';
                if (!labelRegex.test(text)) continue; // skip containers without any target label

                // find the element inside container that contains one of the target labels
                const labelEl = Array.from(c.querySelectorAll('*')).find(el => labelRegex.test(el.textContent || ''));

                let dateText = null;
                let foundLabel = null;
                if (labelEl) {
                    const lm = (labelEl.textContent || '').match(labelRegex);
                    if (lm) foundLabel = lm[0].trim();
                    // look for date in labelEl text first
                    const m1 = (labelEl.textContent || '').match(dateRegex);
                    if (m1) dateText = m1[0].trim();
                    else {
                        // look at nextSibling element text
                        const next = labelEl.nextElementSibling;
                        if (next && dateRegex.test(next.textContent || '')) {
                            dateText = (next.textContent || '').match(dateRegex)[0].trim();
                        } else {
                            // search container for any date-like substring
                            const m2 = (c.textContent || '').match(dateRegex);
                            if (m2) dateText = m2[0].trim();
                        }
                    }
                } else {
                    // no label element, but container text contains one of the labels; attempt to extract label and date from container
                    const lm = (text || '').match(labelRegex);
                    if (lm) foundLabel = lm[0].trim();
                    const m = (text || '').match(dateRegex);
                    if (m) dateText = m[0].trim();
                }

                // find title/link inside container — prefer meaningful text and avoid picking the label itself
                let title = null;
                let titleEl = null;
                // prefer links that look like activity links and whose text isn't the label
                const links = Array.from(c.querySelectorAll('a[href]'));
                const goodLink = links.find(a => {
                    const t = (a.textContent || '').trim();
                    return t.length > 3 && !labelRegex.test(t);
                });
                if (goodLink) {
                    title = goodLink.textContent.trim();
                    titleEl = goodLink;
                } else {
                    // fallback to headings
                    const h = c.querySelector('h1,h2,h3,h4,h5');
                    if (h && h.textContent.trim() && !labelRegex.test(h.textContent)) {
                        title = h.textContent.trim();
                        titleEl = h;
                    } else {
                        // lastly try strong/b elements but avoid those that are just the label
                        const strong = Array.from(c.querySelectorAll('strong,b')).find(s => {
                            const t = (s.textContent || '').trim();
                            return t.length > 3 && !labelRegex.test(t);
                        });
                        if (strong) {
                            title = strong.textContent.trim();
                            titleEl = strong;
                        }
                    }
                }

                let when = null;
                if (dateText) when = parseDateString(dateText);

                if (title || dateText) results.push({ title: title || '(no title found)', titleEl, dateText: dateText || '(no date found)', when, container: c, label: foundLabel });
            } catch (e) {
                // ignore parse errors per container
                console.warn('scan container error', e);
            }
        }

        return results;
    }

    function parseDateString(s) {
        // Try to parse several common patterns. This is forgiving but not perfect.
        // Examples the site may show: "Tuesday, September 16, 2025, 11:59 PM" or "Closed: Tuesday, Sep 16, 2025, 11:59 PM"
        const cleaned = s.replace(/\s+\|\s+/g, ' ').trim();
        // Try Date.parse first
        let dt = Date.parse(cleaned);
        if (!isNaN(dt)) return new Date(dt);

        // Try to strip trailing words like 'Closed' or parentheses
        const paren = cleaned.replace(/\(.*\)/, '').trim();
        dt = Date.parse(paren);
        if (!isNaN(dt)) return new Date(dt);

        // Try common format: 'Tuesday, September 16, 2025, 11:59 PM'
        const repl = paren.replace(/(st|nd|rd|th),?/gi, '');
        dt = Date.parse(repl);
        if (!isNaN(dt)) return new Date(dt);

        // If still not parseable, return null but store raw text
        return null;
    }

    function showParsedResults(results) {
        const existing = document.getElementById('hfcc-parse-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'hfcc-parse-modal';
        modal.style.position = 'fixed';
        modal.style.right = '16px';
        modal.style.bottom = '16px';
        modal.style.width = '420px';
        modal.style.maxHeight = '60%';
        modal.style.overflow = 'auto';
        modal.style.background = '#fff';
        modal.style.border = '1px solid #666';
        modal.style.padding = '10px';
        modal.style.zIndex = 1000000;

        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.float = 'right';
        close.addEventListener('click', () => modal.remove());
        modal.appendChild(close);

        const h = document.createElement('h4');
        h.textContent = 'Parsed "Closes:" items (' + results.length + ')';
        modal.appendChild(h);

        const list = document.createElement('ol');
        results.forEach((r) => {
            const li = document.createElement('li');
            const whenText = r.when ? r.when.toString() : ('UNPARSED: ' + r.dateText);
            const labelText = r.label ? `<div class="small">Label: ${escapeHtml(r.label)}</div>` : '';
            li.innerHTML = `<strong>${escapeHtml(r.title)}</strong>${labelText}<div class="small">${escapeHtml(r.dateText)}</div><div class="small">Parsed: ${escapeHtml(whenText)}</div>`;
            li.style.cursor = 'pointer';
            li.addEventListener('click', () => {
                if (r.titleEl) {
                    r.titleEl.scrollIntoView({behavior: 'smooth', block: 'center'});
                    const prev = r.titleEl.style.outline;
                    r.titleEl.style.outline = '3px solid rgba(0,128,0,0.9)';
                    setTimeout(() => { r.titleEl.style.outline = prev; }, 3000);
                }
            });
            list.appendChild(li);
        });
        modal.appendChild(list);
        document.body.appendChild(modal);
    }

    // --- Create events ---
    async function createEventsFromParsed() {
        if (!tokenState) return setStatus('Not connected to Google');
        const calSelect = document.getElementById('hfcc-calendar-select');
        if (!calSelect || !calSelect.value) return setStatus('Select a target calendar first');

        setStatus('Scanning for items to create...');
        const results = await scanForCloses();

        if (!results || results.length === 0) return setStatus('No parsed items to create');

        if (!confirm('Create ' + results.length + ' events in the chosen calendar?')) return setStatus('Cancelled');

        setStatus('Creating events...');
        const calendarId = document.getElementById('hfcc-calendar-select').value;
        let created = 0;
        for (const item of results) {
            if (!item.when) {
                console.log('Skipping unparsed item', item);
                continue;
            }

            // event payload
            const start = item.when.toISOString();
            // default to 30min duration
            const end = new Date(item.when.getTime() + 30 * 60000).toISOString();
            // include label in summary/description if available
            const normalizedLabel = item.label ? item.label.replace(/:$/, '').trim() : '';
            const summaryText = normalizedLabel ? `${normalizedLabel} — ${item.title}` : item.title;
            const descriptionText = `From HFCC${normalizedLabel ? ' (' + normalizedLabel + ')' : ''} — ${item.dateText || ''}`;
            const event = {
                summary: summaryText,
                description: descriptionText,
                start: { dateTime: start },
                end: { dateTime: end },
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'popup', minutes: 7 * 24 * 60 }, // 7 days before
                    ],
                },
            };

            try {
                // simple duplicate check: search events in a short window around start
                const windowStart = new Date(item.when.getTime() - 5 * 60000).toISOString();
                const windowEnd = new Date(item.when.getTime() + 5 * 60000).toISOString();
                const q = `timeMin=${encodeURIComponent(windowStart)}&timeMax=${encodeURIComponent(windowEnd)}&singleEvents=true`;
                const listRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, {
                    headers: { Authorization: 'Bearer ' + tokenState.access_token },
                });
                if (!listRes.ok) {
                    console.warn('Failed to query events', await listRes.text());
                } else {
                    const listJson = await listRes.json();
                    const dup = (listJson.items || []).some(e => e.summary === item.title && e.start && e.start.dateTime && Math.abs(new Date(e.start.dateTime) - item.when) < 2 * 60000);
                    if (dup) {
                        console.log('Skipping duplicate', item.title);
                        continue;
                    }
                }

                const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + tokenState.access_token, 'Content-Type': 'application/json' },
                    body: JSON.stringify(event),
                });
                if (!res.ok) {
                    const text = await res.text();
                    console.error('Failed create event', text);
                } else {
                    created++;
                    console.log('Created event for', item.title);
                }
            } catch (e) {
                console.error('Create event error', e);
            }
        }

        setStatus('Finished creating events: ' + created + ' created');
        // Create weekly overview events grouped by Monday
        try {
            const byWeek = {};
            for (const it of results) {
                if (!it.when) continue;
                // find Monday for the week
                const d = new Date(it.when.getTime());
                const day = d.getDay();
                const diff = (day + 6) % 7; // days since Monday
                const monday = new Date(d.getTime() - diff * 24 * 60 * 60000);
                monday.setHours(8, 0, 0, 0); // Monday 8:00 AM overview
                const key = monday.toISOString();
                byWeek[key] = byWeek[key] || [];
                byWeek[key].push(it);
            }

            for (const mondayIso of Object.keys(byWeek)) {
                const items = byWeek[mondayIso];
                const mondayDate = new Date(mondayIso);
                const overviewSummary = `Week overview — ${mondayDate.toLocaleDateString()}`;
                const overviewBody = items.map(i => `- ${i.title} — ${i.dateText || ''}`).join('\n');

                // check for existing overview event at that exact time
                const listRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(new Date(mondayDate.getTime()).toISOString())}&timeMax=${encodeURIComponent(new Date(mondayDate.getTime()+3600000).toISOString())}&singleEvents=true`, { headers: { Authorization: 'Bearer ' + tokenState.access_token } });
                let exists = false;
                if (listRes.ok) {
                    const listJson = await listRes.json();
                    exists = (listJson.items || []).some(e => e.summary === overviewSummary);
                }

                if (!exists) {
                    const overviewEvent = {
                        summary: overviewSummary,
                        description: overviewBody,
                        start: { dateTime: mondayDate.toISOString() },
                        end: { dateTime: new Date(mondayDate.getTime() + 60 * 60000).toISOString() },
                        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 * 24 * 7 }] },
                    };
                    const createRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
                        method: 'POST',
                        headers: { Authorization: 'Bearer ' + tokenState.access_token, 'Content-Type': 'application/json' },
                        body: JSON.stringify(overviewEvent),
                    });
                    if (!createRes.ok) console.warn('Failed to create overview event', await createRes.text());
                    else console.log('Created weekly overview for', mondayIso);
                } else {
                    console.log('Overview already exists for', mondayIso);
                }
            }
        } catch (e) {
            console.error('Failed to create weekly overviews', e);
        }
    }

    function showScanModal(matched, counts) {
        // remove existing modal
        const existing = document.getElementById('hfcc-scan-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'hfcc-scan-modal';
        modal.style.position = 'fixed';
        modal.style.left = '16px';
        modal.style.top = '16px';
        modal.style.right = '16px';
        modal.style.bottom = '16px';
        modal.style.background = 'rgba(255,255,255,0.98)';
        modal.style.zIndex = 1000000;
        modal.style.overflow = 'auto';
        modal.style.border = '2px solid #444';
        modal.style.padding = '12px';
        modal.style.boxShadow = '0 8px 40px rgba(0,0,0,0.3)';

        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.float = 'right';
        close.addEventListener('click', () => modal.remove());
        modal.appendChild(close);

        const h = document.createElement('h3');
        h.textContent = 'Scan debug — matched elements: ' + matched.length;
        modal.appendChild(h);

        const note = document.createElement('div');
        note.className = 'small';
        note.textContent = 'Click any sample item to scroll to and highlight it on the page.';
        modal.appendChild(note);

        const countsPre = document.createElement('pre');
        countsPre.textContent = 'Counts per selector: ' + JSON.stringify(counts, null, 2);
        modal.appendChild(countsPre);

        const list = document.createElement('ol');
        list.style.maxHeight = '60%';
        list.style.overflow = 'auto';
        list.style.padding = '6px';

        const sample = matched.slice(0, 200);
        sample.forEach((m, i) => {
            const li = document.createElement('li');
            const t = (m.el.textContent || '').trim().slice(0, 180) || (m.el.tagName || 'EMPTY');
            li.textContent = t;
            li.style.cursor = 'pointer';
            li.title = m.el.outerHTML ? m.el.outerHTML.slice(0, 1000) : '';
            li.addEventListener('click', () => {
                // scroll to element and flash border bitch
                m.el.scrollIntoView({behavior: 'smooth', block: 'center'});
                const prev = m.el.style.outline;
                m.el.style.outline = '3px solid rgba(255,0,0,0.9)';
                setTimeout(() => { m.el.style.outline = prev; }, 3000);
            });
            list.appendChild(li);
        });

        modal.appendChild(list);
        document.body.appendChild(modal);
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
