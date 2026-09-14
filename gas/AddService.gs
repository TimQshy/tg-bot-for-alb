// ===== AddService.js =====
// Add-service wizard — ported from scenes/admin/addService.js

var ADD_SERVICE_SCENE = {
  steps: [
    // Step 0: ask name
    function (ctx, session) {
      ctx.reply(
        '💅 *Добавить услугу*\n\nВведите название:',
        Object.assign({ parse_mode: 'Markdown' }, ik_([[btn_('❌ Отмена', 'cancel')]]))
      );
      advanceScene_(ctx, session);
    },

    // Step 1: save name, ask price
    function (ctx, session) {
      if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel') {
        ctx.answerCbQuery();
        ctx.reply('Отменено.');
        leaveScene_(ctx.from.id);
        return;
      }
      if (!ctx.message || !ctx.message.text) return;

      session.state.name = ctx.message.text.trim();
      ctx.reply('Введите цену (₽):');
      advanceScene_(ctx, session);
    },

    // Step 2: save price, ask duration
    function (ctx, session) {
      if (!ctx.message || !ctx.message.text) return;

      var price = parseFloat(ctx.message.text.replace(',', '.'));
      if (isNaN(price) || price <= 0) {
        ctx.reply('Введите корректную цену (например: 1500):');
        return;
      }
      session.state.price = price;
      ctx.reply('Введите длительность в минутах (например: 60):');
      advanceScene_(ctx, session);
    },

    // Step 3: save duration -> create
    function (ctx, session) {
      if (!ctx.message || !ctx.message.text) return;

      var dur = parseInt(ctx.message.text, 10);
      if (isNaN(dur) || dur < 15 || dur > 480) {
        ctx.reply('Введите длительность от 15 до 480 минут:');
        return;
      }

      var svc = Db.createService({
        name: session.state.name,
        description: null,
        durationMinutes: dur,
        price: session.state.price,
      });

      ctx.reply(
        '✅ Услуга *' + escMd_(svc.name) + '* добавлена!\n💰 ' + svc.price + '₽  ·  ⏱ ' + svc.duration_minutes + ' мин\n\n' +
        'Назначьте её мастерам через /admin → Мастера',
        { parse_mode: 'Markdown' }
      );
      leaveScene_(ctx.from.id);
    },
  ],

  onStart: function (ctx) { leaveScene_(ctx.from.id); },
};
