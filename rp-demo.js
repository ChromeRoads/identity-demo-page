/* The customer-shaped page's one script (RP step 3e). A plain-JavaScript port of the Admin's
 * ux/src/utils/rpCeremony.ts + webauthnCeremony.ts (RP PR 6b), so the page needs no build.
 *
 * Contract: rp/CONTRACT.md §2.2 (ceremony token), §4.1 (routes), §6.4 (ceremonies, refusal sentences).
 * The page never sees a tenant credential and never chooses WebAuthn policy: the backend chose it when
 * it opened the intent; the RP's options carry it.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- base64url (RFC 4648 §5, no padding)
  const b64urlToBytes = (s) => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bytesToB64url = (buf) => {
    if (!buf) return null;
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // ---------------------------------------------------------------- options: JSON → the browser's shapes
  // Prefer the platform parsers (Chrome 116+, Safari 17.4+); fall back to the hand conversion the Admin uses.
  const toCreationOptions = (options) => {
    const pk = options.publicKey;
    if (window.PublicKeyCredential && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
      return { publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(pk) };
    }
    return {
      publicKey: {
        ...pk,
        challenge: b64urlToBytes(pk.challenge),
        user: { ...pk.user, id: b64urlToBytes(pk.user.id) },
        excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBytes(c.id) }))
      }
    };
  };
  const toRequestOptions = (options) => {
    const pk = options.publicKey;
    if (window.PublicKeyCredential && typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
      return { publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(pk) };
    }
    const out = { ...pk, challenge: b64urlToBytes(pk.challenge) };
    if (pk.allowCredentials) out.allowCredentials = pk.allowCredentials.map((c) => ({ ...c, id: b64urlToBytes(c.id) }));
    return { publicKey: out };
  };

  // ---------------------------------------------------------------- the response: PublicKeyCredential → JSON
  // `toJSON()` where the browser has it; otherwise the same wire shape by hand (the RP reads only
  // id, response.clientDataJSON, response.attestationObject | authenticatorData + signature, response.transports).
  const credentialToJSON = (credential) => {
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    const r = credential.response;
    const base = {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || null,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {}
    };
    if ('attestationObject' in r) {
      return {
        ...base,
        response: {
          clientDataJSON: bytesToB64url(r.clientDataJSON),
          attestationObject: bytesToB64url(r.attestationObject),
          transports: typeof r.getTransports === 'function' ? r.getTransports() : []
        }
      };
    }
    return {
      ...base,
      response: {
        clientDataJSON: bytesToB64url(r.clientDataJSON),
        authenticatorData: bytesToB64url(r.authenticatorData),
        signature: bytesToB64url(r.signature),
        userHandle: bytesToB64url(r.userHandle)
      }
    };
  };

  // ---------------------------------------------------------------- the RP calls
  class RpError extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
  }
  const intentUrl = (h, suffix) => `${h.rp.replace(/\/+$/, '')}/v1/authorization-intents/${encodeURIComponent(h.intent)}${suffix}`;
  async function rpCall(h, suffix, method, body) {
    let res;
    try {
      res = await fetch(intentUrl(h, suffix), {
        method,
        mode: 'cors',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${h.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      // A blocked CORS preflight lands here: the browser hides the RP's answer. rp/CONTRACT.md §4.3.
      throw new RpError(0, `The RP could not be reached from this origin (${e && e.message ? e.message : 'network error'}). If the RP answered, its CORS allowlist does not contain ${location.origin}.`);
    }
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* empty body; the status carries the meaning */ }
    if (!res.ok) throw new RpError(res.status, payload && typeof payload.detail === 'string' ? payload.detail : `RP answered HTTP ${res.status}`);
    return payload;
  }
  const readCeremony = (h) => rpCall(h, '/ceremony', 'GET');
  const ceremonyOptions = (h) => rpCall(h, '/ceremony/options', 'POST', {});
  const ceremonyVerify = (h, credential) => rpCall(h, '/ceremony/verify', 'POST', { credential: credentialToJSON(credential) });

  // ---------------------------------------------------------------- the page
  const $ = (id) => document.getElementById(id);
  const log = (text, cls) => { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; $('log').appendChild(li); };
  const handoff = () => ({ rp: $('rp').value.trim(), intent: $('intent').value.trim(), token: $('token').value.trim() });
  let ceremony = null;

  $('origin').textContent = location.origin;

  // The hand-off arrives in the fragment: #rp=…&intent=…&token=…  (never the query string).
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  for (const k of ['rp', 'intent', 'token']) if (frag.get(k)) $(k).value = frag.get(k);
  if (frag.get('token')) history.replaceState(null, '', location.pathname + location.search); // keep the one-time token out of the address bar

  $('load').addEventListener('click', async () => {
    const h = handoff();
    $('log').textContent = ''; $('result').hidden = true; $('copy').hidden = true; $('run').disabled = true;
    if (!h.rp || !h.intent || !h.token) { log('RP URL, intent id and ceremony token are all required.', 'bad'); return; }
    try {
      ceremony = await readCeremony(h);
      const dl = $('view'); dl.innerHTML = '';
      for (const [k, v] of Object.entries(ceremony)) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = String(v); dl.append(dt, dd); }
      dl.hidden = false;
      $('view-summary').textContent = `${ceremony.purpose} · ${ceremony.state}`; $('view-summary').hidden = false;
      log(`Ceremony read from ${h.rp}: ${ceremony.purpose} for rp_id ${ceremony.rp_id}, expires ${ceremony.expires_at}.`, 'ok');
      $('run').disabled = ceremony.state !== 'PENDING';
      if (ceremony.state !== 'PENDING') log(`This intent is ${ceremony.state}; ask the backend for a new one.`, 'bad');
    } catch (e) {
      log(e instanceof RpError ? `RP refused (${e.status}): ${e.detail}` : `Error: ${e.message}`, 'bad');
    }
  });

  $('run').addEventListener('click', async () => {
    const h = handoff();
    $('run').disabled = true;
    try {
      log('POST …/ceremony/options');
      const issued = await ceremonyOptions(h);
      const pk = issued.options.publicKey;
      let credential;
      if (ceremony.purpose === 'webauthn.registration') {
        log(`Options: rp.id=${pk.rp.id} user.name=${pk.user.name} algs=${pk.pubKeyCredParams.map((p) => p.alg).join(',')} exclude=${(pk.excludeCredentials || []).length} uv=${pk.authenticatorSelection && pk.authenticatorSelection.userVerification}`);
        log('navigator.credentials.create() — touch your authenticator');
        credential = await navigator.credentials.create(toCreationOptions(issued.options));
      } else if (ceremony.purpose === 'webauthn.authentication') {
        log(`Options: rpId=${pk.rpId} allow=${pk.allowCredentials ? pk.allowCredentials.length : 'discoverable'} uv=${pk.userVerification}`);
        log('navigator.credentials.get() — touch your authenticator');
        credential = await navigator.credentials.get(toRequestOptions(issued.options));
      } else {
        throw new Error(`This page knows no ceremony for purpose ${ceremony.purpose}`);
      }
      if (!credential) throw new Error('The authenticator returned nothing (cancelled).');
      log(`Authenticator answered: credential id ${credential.id.slice(0, 24)}…`);
      log('POST …/ceremony/verify');
      const verified = await ceremonyVerify(h, credential);
      log(`RP: ${verified.state} — ${verified.purpose}; credential ${verified.credential.credential_id.slice(0, 24)}… sign_count=${verified.credential.sign_count} user_verified=${verified.user_verified}`, 'ok');
      $('result').textContent = JSON.stringify(verified, null, 2); $('result').hidden = false; $('copy').hidden = false;
      log('Done. The backend can now read the intent: GET /v1/authorization-intents/{id} → APPROVED with this result.', 'ok');
    } catch (e) {
      if (e instanceof RpError) log(e.status ? `RP refused (${e.status}): ${e.detail}` : e.detail, 'bad');
      else log(`${e.name || 'Error'}: ${e.message}`, 'bad');
      // A refused verification leaves the ceremony pending (rp/CONTRACT.md §6.4): the same token may try again.
      $('run').disabled = !(ceremony && ceremony.state === 'PENDING');
    }
  });

  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('result').textContent); log('Result copied.', 'ok'); } catch (_) { log('Clipboard unavailable; select the text instead.'); }
  });
})();
