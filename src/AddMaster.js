// Add-master wizard — ported from scenes/admin/addMaster.js

var ADD_MASTER_SCENE = {
  steps: [
    // Step 0: ask name
    function (ctx, session) {
      ctx.reply(
        '👩 *Добавить мастера*\n\nВведите имя:',
        Object.assign({ parse_mode: 'Markdown' }, ik_([[btn_('❌ Отмена', 'cancel')]]))
      );
      advanceScene_(ctx, session);
    },

    // Step 1: save name, ask description
    function (ctx, session) {
      if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel') {
        ctx.answerCbQuery();
        ctx.reply('Отменено.');
        leaveScene_(ctx.from.id);
        return;
      }
      if (!ctx.message || !ctx.message.text) return;

      session.state.name = ctx.message.text.trim();

      ctx.reply('Описание мастера (специализация, стаж …)\nИли пропустите:', ik_([
        [btn_('⏭ Пропустить', 'skip')],
        [btn_('❌ Отмена', 'cancel')],
      ]));
      advanceScene_(ctx, session);
    },

    // Step 2: save description -> create
    function (ctx, session) {
      if (ctx.callbackQuery) {
        ctx.answerCbQuery();
        if (ctx.callbackQuery.data === 'cancel') { ctx.reply('Отменено.'); leaveScene_(ctx.from.id); return; }
        if (ctx.callbackQuery.data === 'skip') session.state.description = null;
      } else if (ctx.message && ctx.message.text) {
        session.state.description = ctx.message.text.trim();
      } else {
        return;
      }

      var master = Db.createMaster(session.state);
      ctx.reply(
        '✅ Мастер *' + master.name + '* добавлен (id: ' + master.id + ').\n\n' +
        'Назначьте услуги и рабочие часы через /admin → Мастера → ' + master.name,
        { parse_mode: 'Markdown' }
      );
      leaveScene_(ctx.from.id);
    },
  ],

  onStart: function (ctx) { leaveScene_(ctx.from.id); },
};
