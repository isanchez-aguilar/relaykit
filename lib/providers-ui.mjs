// `relaykit providers ui`: a small local page to edit the providers file
// (which providers, plan, models, enabled, and the order of priority).
//
// It binds to 127.0.0.1 only, checks Host and Origin, and needs a per-process
// token for the one write. It edits the user-level providers file; a repo's own
// .ai/providers.json is edited by hand.
//
// Dependency-free: Node 18+ built-ins only.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CAPABILITIES, COSTS, FAMILIES, KINDS, normalizeProviders, saveProviders } from './providers.mjs';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relaykit providers</title><link rel="stylesheet" href="/app.css"></head><body><main><h1>Providers</h1><p class="hint">Top is tried first. A task goes to the first enabled provider that can do it. Never put keys here.</p><div id="status" role="status"></div><ol id="list"></ol><div class="bar"><button id="add" type="button">Add provider</button><button id="save" type="button" class="primary">Save</button></div><p id="where" class="hint"></p></main><script src="/app.js"></script></body></html>`;

const CSS = `body{font:16px/1.4 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1a}main{max-width:52rem;margin:0 auto;padding:1.5rem 1rem 4rem}h1{margin:0 0 .25rem}.hint{color:#5c5c57;margin:.25rem 0 1rem}ol{list-style:none;margin:0;padding:0}li{background:#fff;border:1px solid #d8d8d2;border-radius:8px;margin:0 0 .75rem;padding:.75rem}li.off{opacity:.6}.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.35rem 0}label{display:flex;flex-direction:column;font-size:.8rem;color:#5c5c57;gap:.15rem}input,select,textarea{font:inherit;padding:.35rem .5rem;border:1px solid #bdbdb6;border-radius:6px;background:#fff;color:inherit}input[type=checkbox]{width:1.1rem;height:1.1rem}button{font:inherit;padding:.4rem .7rem;border:1px solid #bdbdb6;border-radius:6px;background:#fff;cursor:pointer}button.primary{background:#1c1c1a;color:#fff;border-color:#1c1c1a}button:disabled{opacity:.4;cursor:default}.bar{display:flex;gap:.5rem;justify-content:space-between;position:sticky;bottom:0;background:#f6f6f4;padding:.75rem 0}.num{font-weight:600;min-width:1.5rem}.models td{padding:.15rem .25rem}.ok{color:#1b6e2d}.bad{color:#b00020}.can{display:flex;flex-wrap:wrap;gap:.6rem}.can label{flex-direction:row;align-items:center;color:inherit;font-size:.9rem}@media (prefers-color-scheme:dark){body{background:#161614;color:#ece9e2}li,input,select,textarea,button{background:#22221f;border-color:#44443f;color:#ece9e2}.bar{background:#161614}.hint,label{color:#a3a39b}button.primary{background:#ece9e2;color:#161614}}`;

const SCRIPT = `(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let meta, providers = [];
  const status = (message, bad) => { const el = $('status'); el.textContent = message; el.className = bad ? 'bad' : 'ok'; };
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value; else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node[key] = value;
    }
    for (const child of children) node.append(child);
    return node;
  };
  const field = (title, input) => el('label', {}, title, input);
  const select = (values, current, onchange) => {
    const node = el('select', { onchange: event => onchange(event.target.value) });
    for (const value of values) { const option = el('option', { value, textContent: value }); option.selected = value === current; node.append(option); }
    return node;
  };
  const text = (value, onchange, width) => el('input', { type: 'text', value: value || '', style: width ? 'width:' + width : '', oninput: event => onchange(event.target.value) });

  function render() {
    const list = $('list'); list.replaceChildren();
    providers.forEach((provider, index) => {
      const item = el('li', { class: provider.enabled ? '' : 'off' });
      const head = el('div', { class: 'row' },
        el('span', { class: 'num', textContent: String(index + 1) }),
        el('label', { style: 'flex-direction:row;align-items:center;gap:.4rem;color:inherit' }, el('input', { type: 'checkbox', checked: provider.enabled, onchange: event => { provider.enabled = event.target.checked; render(); } }), 'enabled'),
        field('Name', text(provider.label, value => { provider.label = value; }, '14rem')),
        field('Id', text(provider.id, value => { provider.id = value; }, '9rem')),
        field('Kind', select(meta.kinds, provider.kind, value => { provider.kind = value; })),
        field('Family', select(meta.families, provider.family, value => { provider.family = value; })),
        el('button', { type: 'button', textContent: 'Up', disabled: index === 0, onclick: () => { [providers[index - 1], providers[index]] = [providers[index], providers[index - 1]]; render(); } }),
        el('button', { type: 'button', textContent: 'Down', disabled: index === providers.length - 1, onclick: () => { [providers[index + 1], providers[index]] = [providers[index], providers[index + 1]]; render(); } }),
        el('button', { type: 'button', textContent: 'Remove', onclick: () => { providers.splice(index, 1); render(); } }));
      item.append(head);
      item.append(el('div', { class: 'row' }, field('Plan / subscription', text(provider.plan, value => { provider.plan = value; }, '16rem')), field('Notes', text(provider.notes, value => { provider.notes = value; }, '24rem'))));
      const can = el('div', { class: 'can' });
      for (const capability of meta.capabilities) {
        can.append(el('label', {}, el('input', { type: 'checkbox', checked: provider.can.includes(capability), onchange: event => {
          provider.can = event.target.checked ? [...provider.can, capability] : provider.can.filter(x => x !== capability);
        } }), capability));
      }
      item.append(el('div', { class: 'row' }, 'Can do:', can));
      const table = el('table', { class: 'models' });
      provider.models.forEach((model, modelIndex) => {
        table.append(el('tr', {},
          el('td', {}, text(model.id, value => { model.id = value; }, '16rem')),
          el('td', {}, select(meta.costs, model.cost, value => { model.cost = value; })),
          el('td', {}, el('label', { style: 'flex-direction:row;align-items:center;gap:.3rem;color:inherit' }, el('input', { type: 'checkbox', checked: Boolean(model.restricted), onchange: event => { model.restricted = event.target.checked; } }), 'extreme only')),
          el('td', {}, el('button', { type: 'button', textContent: 'x', onclick: () => { provider.models.splice(modelIndex, 1); render(); } }))));
      });
      item.append(el('div', { class: 'row' }, 'Models:'), table,
        el('button', { type: 'button', textContent: 'Add model', onclick: () => { provider.models.push({ id: '', cost: 'mid' }); render(); } }));
      list.append(item);
    });
  }

  async function load() {
    const response = await fetch('/api/providers');
    const body = await response.json();
    meta = body.meta; providers = body.providers;
    $('where').textContent = 'Saved to ' + body.file + (body.repoOverride ? '. This folder has its own ' + body.repoOverride + ', which wins here and is not edited by this page.' : '');
    render();
  }

  $('add').addEventListener('click', () => {
    providers.push({ id: 'new-provider', label: 'New provider', kind: 'other', family: 'other', enabled: true, plan: '', models: [], can: [], notes: '' });
    render();
  });
  $('save').addEventListener('click', async () => {
    status('Saving...');
    const response = await fetch('/api/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Relaykit-Token': meta.token }, body: JSON.stringify({ providers }) });
    const body = await response.json();
    if (!response.ok) return status(body.error || 'Could not save.', true);
    providers = body.providers; render(); status('Saved.');
  });
  load().catch(error => status(error.message, true));
})();`;

/**
 * The server, not yet listening. `load()` returns `{ source, file, providers }`;
 * `save(providers)` validates, writes and returns the clean list.
 */
export function createProvidersUi({ load, save = null, file, port = 4319 } = {}) {
  const token = randomBytes(24).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const writer = save ?? (providers => saveProviders(file, providers));
  const meta = { kinds: KINDS, families: FAMILIES, costs: COSTS, capabilities: CAPABILITIES, token };

  const server = createServer(async (req, res) => {
    const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };
    const json = (status, value) => send(status, 'application/json', JSON.stringify(value));
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!hosts.has(req.headers.host)) return json(403, { error: 'Host not allowed.' });
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/') return send(200, 'text/html', PAGE);
      if (req.method === 'GET' && path === '/app.js') return send(200, 'text/javascript', SCRIPT);
      if (req.method === 'GET' && path === '/app.css') return send(200, 'text/css', CSS);
      if (req.method === 'GET' && path === '/api/providers') {
        const current = load();
        return json(200, { source: current.source, file: file ?? current.file, repoOverride: current.repoOverride ?? null, providers: current.providers, meta });
      }
      if (req.method === 'PUT' && path === '/api/providers') {
        const sent = Buffer.from(String(req.headers['x-relaykit-token'] || ''));
        const expected = Buffer.from(token);
        if (req.headers.origin !== `http://${req.headers.host}` || sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
          return json(403, { error: 'Request not allowed.' });
        }
        let body = '';
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 65536) return json(413, { error: 'Too large.' }); }
        const clean = normalizeProviders(JSON.parse(body || '{}'), 'request');
        return json(200, { ok: true, providers: writer(clean) });
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      return json(400, { error: error.message });
    }
  });
  return { server, origin, token };
}
