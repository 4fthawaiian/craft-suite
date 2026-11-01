// Craft Suite storage shim.
// Intercepts blob-anchor "downloads" (the wasm apps' only save path) and
// uploads them to /api/save instead. Intercepts <input type=file> opens and
// offers files stored on the server, injected back as real File objects.
(() => {
  if (window.__suiteShim) return;
  window.__suiteShim = true;

  const app = location.pathname.split('/').filter(Boolean)[0] || 'shared';
  const origClick = HTMLElement.prototype.click;
  let currentServerFile = null;  // name of the file opened from server this session
  let currentOwner = null;       // owner of that file when admin opened another user's
  let lastBlob = null;           // blob from the most recent intercepted save

  function toast(msg, ms = 2800, action = null) {
    let t = document.getElementById('suite-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'suite-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
        'background:#232936;color:#e8eaee;border:1px solid #3a4150;border-radius:10px;' +
        'padding:10px 16px;font:13px system-ui,sans-serif;z-index:999999;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .3s';
      document.body.appendChild(t);
    }
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    t.style.pointerEvents = 'none';
    t.onclick = null;
    t.style.cursor = 'default';
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:10px;background:transparent;border:0;color:#7da6ff;' +
        'font:600 13px system-ui;padding:2px 4px;cursor:pointer';
      btn.onclick = () => { t.style.opacity = '0'; action.fn(); };
      t.appendChild(btn);
      t.style.pointerEvents = 'auto';
    }
    t.style.opacity = '1';
    clearTimeout(t.__h);
    t.__h = setTimeout(() => { t.style.opacity = '0'; }, ms);
  }

  function modalShell(bodyHTML) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,12,16,.72);' +
      'z-index:999998;display:flex;align-items:center;justify-content:center;' +
      'font:14px system-ui,sans-serif';
    const card = document.createElement('div');
    card.style.cssText = 'background:#1a1e26;border:1px solid #2a2f3a;border-radius:14px;' +
      'width:min(480px,92vw);max-height:70vh;display:flex;flex-direction:column;overflow:hidden';
    card.innerHTML = bodyHTML;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    return { overlay, card, close: () => overlay.remove() };
  }

  function postBlob(name, blob, owner = null) {
    const u = owner ? `&user=${encodeURIComponent(owner)}` : '';
    return fetch(`/api/save?app=${app}&name=${encodeURIComponent(name)}${u}`,
      { method: 'POST', body: blob })
      .then(r => { if (!r.ok) throw 0; });
  }

  function saveDialog(anchor, presetName = null, blob = null) {
    const name = presetName || anchor.download || 'untitled';
    const { card, close } = modalShell(`
      <div style="padding:14px 18px;border-bottom:1px solid #2a2f3a;color:#e8eaee;font-weight:600">
        Save <span style="color:#7d8494;font-weight:400;font-size:12px">— ${app}</span>
      </div>
      <div style="padding:16px 18px">
        <input class="suite-name" style="width:100%;box-sizing:border-box;background:#111318;border:1px solid #3a4150;border-radius:8px;color:#e8eaee;padding:10px 12px;font:14px system-ui" value="">
      </div>
      <div style="padding:12px 14px;border-top:1px solid #2a2f3a;display:flex;gap:10px;justify-content:flex-end">
        <button class="suite-device" style="background:transparent;border:1px solid #3a4150;color:#a9b0be;border-radius:8px;padding:8px 14px;font:13px system-ui">Save to device…</button>
        <button class="suite-server" style="background:#4d7cff;border:0;color:#fff;border-radius:8px;padding:8px 16px;font:13px system-ui">Save to server</button>
      </div>`);
    const field = card.querySelector('.suite-name');
    field.value = name;
    field.focus();
    field.setSelectionRange(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length);

    const doSave = () => {
      const to = field.value.trim() || name;
      close();
      const got = blob ? Promise.resolve(blob) : fetch(anchor.href).then(r => r.blob());
      got.then(b => {
        lastBlob = b;
        return postBlob(to, b);
      }).then(() => {
        currentServerFile = to;
        toast(`Saved to server: ${to}`);
      }).catch(() => {
        toast('Server save failed — downloading instead');
        anchor.__native = true;
        origClick.call(anchor);
      });
    };
    card.querySelector('.suite-server').onclick = doSave;
    field.onkeydown = e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') close(); e.stopPropagation(); };
    card.querySelector('.suite-device').onclick = () => {
      close();
      anchor.download = field.value.trim() || name;
      anchor.__native = true;
      origClick.call(anchor);
    };
  }

  // "Save" on a file opened from (or previously saved to) the server:
  // quiet overwrite, toast offers a path to Save-As so copies stay reachable.
  function silentSave(anchor) {
    const name = anchor.download;
    fetch(anchor.href)
      .then(r => r.blob())
      .then(b => {
        lastBlob = b;
        return postBlob(name, b, currentOwner);
      })
      .then(() => toast(`Saved to server: ${name}`, 5000,
        { label: 'Save a copy…', fn: () => saveDialog(anchor, name, lastBlob) }))
      .catch(() => {
        toast('Server save failed — downloading instead');
        anchor.__native = true;
        origClick.call(anchor);
      });
  }

  // fetch a server file and hand it to the app's file input as a real File
  function injectFile(input, name, mtime, owner = null) {
    toast(`Opening ${name}…`);
    const u = owner ? `&user=${encodeURIComponent(owner)}` : '';
    fetch(`/api/file?app=${app}&name=${encodeURIComponent(name)}${u}`)
      .then(r => { if (!r.ok) throw 0; return r.blob(); })
      .then(b => {
        const file = new File([b], name, { type: b.type, lastModified: mtime || Date.now() });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        currentServerFile = name;
        currentOwner = owner;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })
      .catch(() => {
        toast(`Failed to open ${name}`);
        serverPicker(input);
      });
  }

  // ?pick=<file>[&owner=<email>] — landing page deep link: next file-open
  // click loads it directly (owner needed for admin cross-user opens)
  const qs = new URLSearchParams(location.search);
  let pendingPick = qs.get('pick');
  const pendingOwner = qs.get('owner');
  if (pendingPick) {
    setTimeout(() => toast(`"${pendingPick}" queued — use the app's Open to load it`, 6000), 1500);
  }

  // parse accept=".xlsx,.png,image/*" loosely into an extension filter
  function acceptsFilter(accept) {
    if (!accept) return null;
    const exts = accept.split(',').map(s => s.trim().toLowerCase())
      .filter(s => s.startsWith('.'));
    return exts.length ? exts : null;
  }

  function serverPicker(input) {
    const exts = acceptsFilter(input.accept);
    const { card, close } = modalShell(`
      <div style="padding:14px 18px;border-bottom:1px solid #2a2f3a;color:#e8eaee;font-weight:600">
        Open from server <span style="color:#7d8494;font-weight:400;font-size:12px">— ${app}</span>
      </div>
      <div class="suite-list" style="flex:1;overflow-y:auto;padding:6px"></div>
      <div style="padding:12px 14px;border-top:1px solid #2a2f3a;display:flex;gap:10px;justify-content:flex-end">
        <button class="suite-device" style="background:transparent;border:1px solid #3a4150;color:#a9b0be;border-radius:8px;padding:8px 14px;font:13px system-ui">From device…</button>
        <button class="suite-cancel" style="background:transparent;border:0;color:#7d8494;padding:8px 10px;font:13px system-ui">Cancel</button>
      </div>`);

    function renderList() {
      fetch(`/api/list?app=${app}`)
        .then(r => r.json())
        .then(({ files }) => {
          const list = card.querySelector('.suite-list');
          const shown = exts ? files.filter(f => exts.some(e => f.name.toLowerCase().endsWith(e))) : files;
          if (!shown.length) {
            list.innerHTML = '<div style="padding:24px;color:#7d8494;text-align:center">No files on the server yet</div>';
            return;
          }
          list.innerHTML = '';
          shown.forEach(f => {
            const row = document.createElement('div');
            row.style.cssText = 'padding:11px 14px;border-radius:8px;cursor:pointer;color:#d4d9e2;display:flex;align-items:center;gap:8px';
            row.onmouseenter = () => row.style.background = '#232936';
            row.onmouseleave = () => row.style.background = '';
            const kb = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB';
            const when = new Date(f.mtime).toLocaleString();
            const ownerBadge = f.owner
              ? `<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:#26304a;color:#9db4f0;margin-left:6px">${f.owner}</span>` : '';
            row.innerHTML = `<div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis">${f.name}${ownerBadge}</div><div style="color:#7d8494;font-size:11.5px;margin-top:2px">${kb} · ${when}</div></div>`;
            const edit = document.createElement('button');
            edit.textContent = '✎';
            edit.title = 'Rename';
            edit.style.cssText = 'background:transparent;border:0;color:#7d8494;font-size:16px;padding:6px;cursor:pointer;flex-shrink:0';
            edit.onclick = e => {
              e.stopPropagation();
              row.innerHTML = '';
              const field = document.createElement('input');
              field.value = f.name;
              field.style.cssText = 'flex:1;min-width:0;background:#111318;border:1px solid #4d7cff;border-radius:6px;color:#e8eaee;padding:7px 10px;font:13px system-ui';
              const ok = document.createElement('button');
              ok.textContent = 'Rename';
              ok.style.cssText = 'background:#4d7cff;border:0;color:#fff;border-radius:6px;padding:7px 12px;font:12.5px system-ui;flex-shrink:0';
              const no = document.createElement('button');
              no.textContent = '✕';
              no.style.cssText = 'background:transparent;border:0;color:#7d8494;font-size:15px;padding:6px;flex-shrink:0';
              const commit = () => {
                const to = field.value.trim();
                if (!to || to === f.name) { renderList(); return; }
                const u = f.owner ? `&user=${encodeURIComponent(f.owner)}` : '';
                fetch(`/api/rename?app=${app}&from=${encodeURIComponent(f.name)}&to=${encodeURIComponent(to)}${u}`, { method: 'POST' })
                  .then(r => {
                    if (r.status === 409) { toast(`"${to}" already exists`); renderList(); return; }
                    if (!r.ok) throw 0;
                    toast(`Renamed to ${to}`);
                    renderList();
                  })
                  .catch(() => { toast('Rename failed'); renderList(); });
              };
              ok.onclick = e => { e.stopPropagation(); commit(); };
              no.onclick = e => { e.stopPropagation(); renderList(); };
              field.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderList(); e.stopPropagation(); };
              row.onclick = null;
              row.append(field, ok, no);
              field.focus();
              field.setSelectionRange(0, f.name.lastIndexOf('.'));
            };
            row.onclick = () => { close(); injectFile(input, f.name, f.mtime, f.owner || null); };
            row.appendChild(edit);
            list.appendChild(row);
          });
        })
        .catch(() => {
          card.querySelector('.suite-list').innerHTML =
            '<div style="padding:24px;color:#d98f8f;text-align:center">Could not reach server storage</div>';
        });
    }
    renderList();

    card.querySelector('.suite-cancel').onclick = close;
    card.querySelector('.suite-device').onclick = () => {
      close();
      input.__native = true;
      origClick.call(input);
    };
  }

  HTMLElement.prototype.click = function () {
    // save/export: anchor with download attr pointing at a blob.
    // Same name as the open server file → "Save" (silent overwrite).
    // Anything else → "Save As" territory → filename dialog.
    if (!this.__native && this.tagName === 'A' && this.download &&
        typeof this.href === 'string' && this.href.startsWith('blob:')) {
      if (this.download === currentServerFile) silentSave(this);
      else saveDialog(this);
      return;
    }
    // open: hidden file input — queued ?pick file wins, else server picker
    if (!this.__native && this.tagName === 'INPUT' && this.type === 'file') {
      if (pendingPick) {
        const name = pendingPick, owner = pendingOwner;
        pendingPick = null;
        injectFile(this, name, null, owner);
      } else {
        serverPicker(this);
      }
      return;
    }
    return origClick.apply(this, arguments);
  };

  // floating pill(s), present in every app: back to suite + sign out when authed
  const pillStyle = 'background:rgba(35,41,54,.85);color:#a9b0be;border:1px solid #3a4150;' +
    'border-radius:99px;padding:8px 14px;font:12.5px system-ui,sans-serif;' +
    'text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.4);backdrop-filter:blur(4px)';
  const dock = document.createElement('div');
  dock.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:999997;display:flex;gap:8px';
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = '⌂ Suite';
  home.style.cssText = pillStyle;
  dock.appendChild(home);
  (document.body ? Promise.resolve() : new Promise(r =>
    document.addEventListener('DOMContentLoaded', r)))
    .then(() => document.body.appendChild(dock))
    .then(() => fetch('/api/whoami').then(r => r.json()))
    .then(({ user }) => {
      if (!user) return;
      const out = document.createElement('a');
      out.href = '/auth/logout';
      out.textContent = '⏻ sign out';
      out.title = `sign out (${user})`;
      out.style.cssText = pillStyle;
      dock.appendChild(out);
    }).catch(() => {});
})();
