/* ReferralMax marketing chatbot — drops in as a single script tag.
   Calls POST /api/public/chat on the Railway backend and renders responses
   including inline screenshots and suggested-reply chips. */

(function () {
  'use strict';

  const API_BASE = 'https://api.referralmax.ai';
  const SCREENSHOT_BASE = 'assets/screenshots/';
  const STORAGE_KEY = 'rmx_chat_v1';
  const STORAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Also capture the referral code here so the widget works even on pages
  // where the main signup form's capture script hasn't loaded yet.
  (function captureRefCode() {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      if (ref && /^[A-Z0-9-]{4,40}$/i.test(ref)) {
        localStorage.setItem('rmx_ref', JSON.stringify({ code: ref.toUpperCase(), ts: Date.now() }));
      }
    } catch { /* ignore */ }
  })();

  function getStoredReferralCode() {
    try {
      const raw = localStorage.getItem('rmx_ref');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.ts || Date.now() - data.ts > 30 * 24 * 60 * 60 * 1000) return null;
      return data.code || null;
    } catch { return null; }
  }

  const WELCOME = {
    role: 'assistant',
    content: "Hey! 👋 I'm the ReferralMax assistant. I can answer questions about how the platform works, pricing, what's included, or help you figure out if it's a fit for your business.\n\nWhat brings you here today?",
    chips: ['How does it work?', 'Pricing', 'Is it for HVAC?', 'See a demo'],
    ts: Date.now(),
  };

  // ── State ───────────────────────────────────────────────
  let state = {
    open: false,
    messages: [WELCOME],
    sending: false,
    leadShown: false,
    leadSubmitted: false,
  };

  // ── Persistence ─────────────────────────────────────────
  function saveState() {
    try {
      const payload = {
        messages: state.messages,
        leadShown: state.leadShown,
        leadSubmitted: state.leadSubmitted,
        ts: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch { /* localStorage full / disabled — no-op */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data.ts || Date.now() - data.ts > STORAGE_TTL_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        state.messages = data.messages;
        state.leadShown = !!data.leadShown;
        state.leadSubmitted = !!data.leadSubmitted;
      }
    } catch { /* corrupt — use defaults */ }
  }

  // ── Content parsing ─────────────────────────────────────
  // Extracts [[screenshot:key]] and [[chips:a|b|c]] tokens from model output.
  function parseResponse(text) {
    let cleaned = text || '';
    const screenshots = [];
    let chips = null;

    cleaned = cleaned.replace(/\[\[screenshot:([a-z0-9_-]+)\]\]/gi, (_, key) => {
      screenshots.push(String(key).toLowerCase());
      return '';
    });
    const chipsMatch = cleaned.match(/\[\[chips:([^\]]+)\]\]/i);
    if (chipsMatch) {
      chips = chipsMatch[1].split('|').map(s => s.trim()).filter(Boolean).slice(0, 4);
      cleaned = cleaned.replace(chipsMatch[0], '');
    }
    return { text: cleaned.trim(), screenshots, chips };
  }

  // ── DOM helpers ─────────────────────────────────────────
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v);
    }
    for (const child of children) {
      if (child == null) continue;
      e.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return e;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
  }

  // ── Rendering ───────────────────────────────────────────
  let rootEl, messagesEl, inputEl, sendBtnEl, bubbleEl, tooltipEl, panelEl;

  function render() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';

    for (let i = 0; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (m.role === 'user') {
        messagesEl.appendChild(
          el('div', { class: 'rmx-chat__row rmx-chat__row--user' },
            el('div', { class: 'rmx-chat__msg rmx-chat__msg--user' }, m.content)
          )
        );
      } else {
        // bot message
        const wrap = el('div', { class: 'rmx-chat__row' });
        wrap.appendChild(el('div', { class: 'rmx-chat__row-avatar' }, 'R'));
        const bodyCol = el('div', { style: { flex: '1', minWidth: 0 } });
        bodyCol.appendChild(el('div', { class: 'rmx-chat__msg rmx-chat__msg--bot' }, m.content));

        (m.screenshots || []).forEach(key => {
          const img = el('img', { src: SCREENSHOT_BASE + key + '.svg', alt: key, onerror: function() { this.parentElement.remove(); } });
          bodyCol.appendChild(el('div', { class: 'rmx-chat__screenshot' }, img));
        });

        wrap.appendChild(bodyCol);
        messagesEl.appendChild(wrap);

        if (m.chips && m.chips.length && i === state.messages.length - 1 && !state.sending) {
          const chipsWrap = el('div', { class: 'rmx-chat__chips' });
          m.chips.forEach(chipText => {
            chipsWrap.appendChild(
              el('button', { class: 'rmx-chat__chip', onclick: () => sendMessage(chipText) }, chipText)
            );
          });
          messagesEl.appendChild(chipsWrap);
        }
      }
    }

    if (state.sending) {
      const wrap = el('div', { class: 'rmx-chat__row' });
      wrap.appendChild(el('div', { class: 'rmx-chat__row-avatar' }, 'R'));
      wrap.appendChild(el('div', { class: 'rmx-chat__typing' },
        el('span'), el('span'), el('span')
      ));
      messagesEl.appendChild(wrap);
    }

    // Lead capture card — shown once, after backend flags it.
    if (state.leadShown && !state.leadSubmitted) {
      messagesEl.appendChild(renderLeadCard());
    }

    // Scroll to bottom.
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderLeadCard() {
    const form = el('form', {
      class: 'rmx-chat__lead',
      onsubmit: (e) => {
        e.preventDefault();
        submitLead(form);
      },
    });
    form.innerHTML = `
      <h4>Want someone to reach out today?</h4>
      <p>I'll pass your info along and a real human will contact you during business hours — no commitment.</p>
      <div class="rmx-chat__hp"><input type="text" name="website_url" tabindex="-1" autocomplete="off" /></div>
      <input name="firstName" placeholder="First name" required />
      <input name="lastName" placeholder="Last name" />
      <input name="email" type="email" placeholder="Work email" required />
      <input name="phone" type="tel" placeholder="Phone" required />
      <input name="company" placeholder="Company name" />
      <button type="submit" class="rmx-chat__lead-submit">Send me more info</button>
      <button type="button" class="rmx-chat__lead-skip">No thanks, just keep chatting</button>
      <div class="rmx-chat__lead-error" data-err></div>
    `;
    form.querySelector('.rmx-chat__lead-skip').addEventListener('click', () => {
      state.leadShown = false; // dismiss
      state.leadSubmitted = true; // won't show again in this convo
      saveState();
      render();
    });
    const wrap = el('div', { class: 'rmx-chat__row' });
    wrap.appendChild(el('div', { class: 'rmx-chat__row-avatar' }, 'R'));
    const col = el('div', { style: { flex: '1', minWidth: 0 } });
    col.appendChild(form);
    wrap.appendChild(col);
    return wrap;
  }

  async function submitLead(form) {
    const submit = form.querySelector('.rmx-chat__lead-submit');
    const errEl = form.querySelector('[data-err]');
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const data = Object.fromEntries(new FormData(form).entries());
    // Build a short excerpt from the last ~10 messages.
    const excerpt = state.messages.slice(-10).map(m =>
      (m.role === 'user' ? 'Visitor' : 'Bot') + ': ' + (m.content || '').slice(0, 300)
    ).join('\n');
    try {
      const res = await fetch(API_BASE + '/api/public/chat/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, conversationSummary: excerpt, referredByCode: getStoredReferralCode() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not send');
      state.leadSubmitted = true;
      state.messages.push({
        role: 'assistant',
        content: "Thanks " + (data.firstName || 'there') + "! Your info is on its way — we'll be in touch today during business hours. In the meantime, ask me anything else about ReferralMax.",
        ts: Date.now(),
      });
      saveState();
      render();
    } catch (err) {
      errEl.textContent = err.message || 'Failed — please try again or email directly.';
      submit.disabled = false;
      submit.textContent = 'Send me more info';
    }
  }

  // ── Sending messages ────────────────────────────────────
  async function sendMessage(rawText) {
    const text = (rawText || '').trim();
    if (!text || state.sending) return;
    state.messages.push({ role: 'user', content: text, ts: Date.now() });
    state.sending = true;
    render();
    saveState();

    try {
      const res = await fetch(API_BASE + '/api/public/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: state.messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      state.sending = false;

      if (!res.ok) {
        state.messages.push({
          role: 'assistant',
          content: body.error || "I'm having trouble responding. Please try again or use the contact form below.",
          ts: Date.now(),
        });
      } else {
        const parsed = parseResponse(body.text);
        state.messages.push({
          role: 'assistant',
          content: parsed.text,
          screenshots: parsed.screenshots,
          chips: parsed.chips,
          ts: Date.now(),
        });
        if (body.showLeadForm && !state.leadSubmitted) state.leadShown = true;
      }
      saveState();
      render();
    } catch (err) {
      state.sending = false;
      state.messages.push({
        role: 'assistant',
        content: "I couldn't reach the server. Please try again in a moment, or use the contact form on this page.",
        ts: Date.now(),
      });
      render();
    }
  }

  // ── Init UI ─────────────────────────────────────────────
  function init() {
    loadState();

    rootEl = el('div', { class: 'rmx-chat' });

    // Tooltip (first-visit only)
    const hasSeenTooltip = localStorage.getItem('rmx_chat_tooltip_seen');
    if (!hasSeenTooltip) {
      tooltipEl = el('div', { class: 'rmx-chat__tooltip' }, '👋 Questions? Ask me anything');
      rootEl.appendChild(tooltipEl);
      localStorage.setItem('rmx_chat_tooltip_seen', '1');
      setTimeout(() => tooltipEl && tooltipEl.remove(), 6000);
    }

    // Bubble
    bubbleEl = el('button', {
      class: 'rmx-chat__bubble',
      'aria-label': 'Open chat',
      onclick: togglePanel,
    });
    bubbleEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
      <span class="rmx-chat__badge" data-hide="${state.messages.length > 1 ? 'true' : 'false'}">1</span>
    `;
    rootEl.appendChild(bubbleEl);

    // Panel
    panelEl = el('div', { class: 'rmx-chat__panel' });

    const header = el('div', { class: 'rmx-chat__header' });
    const info = el('div', { class: 'rmx-chat__header-info' });
    const av = el('div', { class: 'rmx-chat__avatar' });
    av.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    info.appendChild(av);
    const meta = el('div');
    meta.appendChild(el('div', { class: 'rmx-chat__title' }, 'ReferralMax'));
    meta.appendChild(el('div', { class: 'rmx-chat__status' }, 'Online — replies in seconds'));
    info.appendChild(meta);
    header.appendChild(info);
    const actions = el('div', { class: 'rmx-chat__header-actions' });
    const closeBtn = el('button', { class: 'rmx-chat__header-btn', 'aria-label': 'Close chat', onclick: togglePanel });
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M6 18L18 6"/></svg>';
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    panelEl.appendChild(header);

    messagesEl = el('div', { class: 'rmx-chat__messages' });
    panelEl.appendChild(messagesEl);

    const inputRow = el('div', { class: 'rmx-chat__input-row' });
    const inputWrap = el('div', { class: 'rmx-chat__input-wrap' });
    inputEl = el('textarea', {
      class: 'rmx-chat__input',
      rows: '1',
      placeholder: 'Ask a question…',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const v = inputEl.value;
          inputEl.value = '';
          autoResize();
          sendMessage(v);
        }
      },
      oninput: autoResize,
    });
    sendBtnEl = el('button', {
      class: 'rmx-chat__send',
      'aria-label': 'Send',
      onclick: () => {
        const v = inputEl.value;
        inputEl.value = '';
        autoResize();
        sendMessage(v);
      },
    });
    sendBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    inputWrap.appendChild(inputEl);
    inputWrap.appendChild(sendBtnEl);
    inputRow.appendChild(inputWrap);
    inputRow.appendChild(el('div', { class: 'rmx-chat__footer' }, 'Powered by Claude · Your conversation stays private'));
    panelEl.appendChild(inputRow);

    rootEl.appendChild(panelEl);
    document.body.appendChild(rootEl);

    render();
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  }

  function togglePanel() {
    state.open = !state.open;
    panelEl.setAttribute('data-open', state.open ? 'true' : 'false');
    bubbleEl.setAttribute('data-open', state.open ? 'true' : 'false');
    if (tooltipEl) tooltipEl.remove();
    if (state.open) setTimeout(() => inputEl && inputEl.focus(), 120);
  }

  // Fire on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
