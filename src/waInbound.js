// The parts of the WhatsApp transport that decide things, kept apart from the
// Baileys socket so they can be tested without one: which messages.upsert
// entries the bot answers, and the QR / adv-secret handling for pairing.
// whatsapp.js wires these into the socket's events.
import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';
import { randomBytes } from 'crypto';

const IDS_MAX = 500;
const IGNORED_CONTENT = new Set(['protocolMessage', 'reactionMessage']);
// A fromMe echo older than this is history replay, not a live reply.
export const HUMAN_ECHO_MAX_AGE_MS = 2 * 60 * 1000;

// Bounded: only the last few hundred ids matter, a redelivery or an echo
// arrives within seconds.
export function rememberId(set, id) {
  set.add(id);
  if (set.size > IDS_MAX) {
    const oldest = set.values();
    for (let i = 0; i < IDS_MAX / 5; i++) set.delete(oldest.next().value);
  }
}

export function fromJid(jid) {
  return jid.split('@')[0];
}

// Returns a function that turns one messages.upsert entry into what the bot
// should do with it, or null to ignore it:
//   { kind: 'client', phone, text, profileName } — a client wrote to us
//   { kind: 'human', phone, text } — the salon answered by hand from a phone
// botSentIds is the set of ids this process sent itself (see whatsapp.js).
export function makeInboundFilter({ botSentIds, now = () => Date.now() }) {
  // Ids already handled — WhatsApp redelivers a message after a failed
  // decrypt, and each copy must not get its own answer.
  const seen = new Set();

  return function classify(m) {
    const jid = m.key?.remoteJid;
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return null;

    // A message Baileys couldn't decrypt yet (signal session being
    // renegotiated, typically right after a fresh link) arrives as a stub
    // with no content; the phone then resends it and the same id can come
    // through more than once. Answering each copy sent a client three main
    // menus for one "Привет". Protocol traffic (revokes, key distribution)
    // and reactions carry nothing to answer either.
    if (!m.message || m.messageStubType) return null;
    const contentType = getContentType(normalizeMessageContent(m.message));
    if (!contentType || IGNORED_CONTENT.has(contentType)) return null;
    if (seen.has(m.key.id)) return null;
    rememberId(seen, m.key.id);

    // Privacy-mode contacts address by LID (an opaque per-account id), not
    // phone number — the real number.@s.whatsapp.net jid, when WhatsApp
    // shares it, is on remoteJidAlt. Prefer whichever side is the actual
    // phone-number jid so `phone` stays a real number everywhere else in
    // the app (admin panel, ADMIN_PHONES matching, booking confirmations).
    const pnJid = [jid, m.key.remoteJidAlt].find(j => j?.endsWith('@s.whatsapp.net'));
    const phone = fromJid(pnJid || jid);

    const text = m.message.conversation || m.message.extendedTextMessage?.text || null;

    if (m.key.fromMe) {
      // Our own send echoing back — ignore.
      if (botSentIds.has(m.key.id)) return null;
      // On reconnect WhatsApp can replay recent messages; an old echo must
      // not re-trigger a takeover long after the fact (and after a restart
      // botSentIds is empty, so even our own sends would look human).
      const ageMs = now() - Number(m.messageTimestamp || 0) * 1000;
      if (ageMs > HUMAN_ECHO_MAX_AGE_MS) return null;
      return { kind: 'human', phone, text };
    }

    return { kind: 'client', phone, text, profileName: m.pushName || undefined };
  };
}

// Since late July 2026 WhatsApp sends companion_reg_refresh mid-pairing to
// retire the adv secret advertised in the QR. Baileys rc14 only acks it, so
// the QR keeps the retired secret and the phone answers "can't link new
// devices right now" (Baileys issue #2737, unreleased fix in PR #2765).
// Workaround until a release ships it: rotate the secret ourselves and
// re-render the QR with it. pair-success reads creds.advSecretKey at
// verification time, so mutating it is enough.
//
// Returns whether the secret changed. An already paired device keeps its
// secret — the session is verified against it.
export function rotateAdvSecret(creds) {
  if (creds.me) return false;
  creds.advSecretKey = randomBytes(32).toString('base64');
  return true;
}

// Baileys builds the QR payload once with the secret of that moment:
// ref,noiseKey,identityKey,advSecret,platformId. Swap in the current one.
export function withAdvSecret(qr, advSecretKey) {
  const parts = qr.split(',');
  parts[parts.length - 2] = advSecretKey;
  return parts.join(',');
}
