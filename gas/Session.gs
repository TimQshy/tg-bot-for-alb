// ===== Session.js =====
// Per-user wizard-scene state, stored in PropertiesService (replaces Telegraf's
// in-memory Scenes.Stage/WizardScene + ctx.session, which can't survive across
// stateless doPost invocations).

function getScene_(name) {
  var map = {
    booking: BOOKING_SCENE,
    addMaster: ADD_MASTER_SCENE,
    addService: ADD_SERVICE_SCENE,
    setHours: SET_HOURS_SCENE,
  };
  return map[name];
}

function getSession_(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty('sess_' + userId);
  return raw ? JSON.parse(raw) : null;
}

function setSession_(userId, session) {
  PropertiesService.getScriptProperties().setProperty('sess_' + userId, JSON.stringify(session));
}

function clearSession_(userId) {
  PropertiesService.getScriptProperties().deleteProperty('sess_' + userId);
}

// Telegraf's ctx.scene.enter(name)
function enterScene_(ctx, sceneName, initialState) {
  var session = { scene: sceneName, step: 0, state: initialState || {} };
  setSession_(ctx.from.id, session);
  runSceneStep_(ctx, session);
}

// Telegraf's ctx.wizard.next()
function advanceScene_(ctx, session) {
  session.step += 1;
  setSession_(ctx.from.id, session);
}

// Telegraf's ctx.scene.leave()
function leaveScene_(userId) {
  clearSession_(userId);
}

function runSceneStep_(ctx, session) {
  var scene = getScene_(session.scene);
  if (!scene) { leaveScene_(ctx.from.id); return; }
  var fn = scene.steps[session.step];
  if (!fn) { leaveScene_(ctx.from.id); return; }
  fn(ctx, session);
}
