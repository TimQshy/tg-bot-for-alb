// The salon's WhatsApp transport: Baileys (waBaileys.js — a linked device
// paired by QR) unless WA_TRANSPORT=cloud picks Meta's official Cloud API
// (waCloud.js). Both export the same three functions, and the rest of the
// app only ever imports from here.
const cloud = process.env.WA_TRANSPORT === 'cloud';
const impl = cloud ? await import('./waCloud.js') : await import('./waBaileys.js');

export const { sendText, connectWhatsApp, getWaStatus } = impl;
// Meta delivers Cloud API messages over HTTP; Baileys has no webhook.
export const webhookRouter = cloud ? impl.waCloudRouter : null;
