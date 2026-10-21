export const MSG = {
    DENIED: 'Нет доступа.',
    WELCOME: [
        'Здравствуйте! Это мобильный пульт DeepSeek Harness в Telegram.',
        'Источник истины — сессии на этом компьютере: откройте диалог в Web, затем через /sessions выберите рабочую область → сессию и привяжитесь.',
        'Отправьте /help, чтобы увидеть команды.',
    ].join('\n'),
    HELP: [
        '/sessions — сессии по рабочим областям (как в Web, без архива) и привязка',
        '/last — последний вопрос-ответ привязанной сессии (чтобы продолжить)',
        '/model — сменить модель привязанной сессии (со следующего хода)',
        '/status — состояние: привязка, ID сессии, рабочая область, модель, глубина размышлений, контекст, токены',
        '/compact — сжать историю сессии (сократить контекст; только когда сессия свободна)',
        '/rich — режим рендера: on=rich (нужен свежий клиент) / off=HTML (по умолчанию); запоминается для этого чата',
        '/unbind — отвязать телефон (сессия на компьютере продолжает работать)',
        '/help — помощь',
        '',
        'После привязки просто пишите текст — сообщение уйдёт в эту сессию; Web и телефон видят одну и ту же переписку.',
        'Картинку (в том числе с подписью) тоже можно отправить — подпись станет текстом сообщения.',
        'Доступ только для пользователей из белого списка. Если сессий нет, сначала создайте диалог в dsh web.',
    ].join('\n'),
    NEED_BIND: 'Сессия ещё не привязана. Отправьте /sessions и выберите одну.',
    NO_SESSIONS: 'Нет сессий для привязки (архивные и пустые скрыты). Откройте или продолжите диалог в Web (dsh web) и снова отправьте /sessions.',
    NO_SESSIONS_IN_WS(title) {
        return `В рабочей области «${title}» нет сессий для привязки.`;
    },
    /** @deprecated use NO_SESSIONS */
    NO_LIVE: 'Нет сессий для привязки. Откройте или продолжите диалог в Web (dsh web) и снова отправьте /sessions.',
    PICKER_STALE: 'Список устарел — отправьте /sessions заново.',
    RESUME_FAILED: 'Не удалось привязать сессию (ошибка resume). Проверьте, что она есть в Web, или откройте её на компьютере и повторите.',
    BOUND(label) {
        return `Сессия привязана: ${label}\nДальше сообщения идут в неё (та же переписка, что в Web).\nЧтобы вспомнить контекст, нажмите «Последний диалог» или отправьте /last.`;
    },
    UNBOUND: 'Привязка снята. Сессия на компьютере продолжает работать.',
    STATUS_NONE: 'Сейчас нет привязанной сессии. Отправьте /sessions и выберите.',
    STATUS_BOUND(label) {
        return `Привязано: ${label}`;
    },
    STATUS_BOUND_COLD(label) {
        return `Привязано: ${label}\n(сессия сейчас не в памяти — при отправке сообщения она поднимется автоматически)`;
    },
    COMPACT_USAGE: 'Использование: /compact (без параметров — сжать историю привязанной сессии, сократить контекст)',
    COMPACT_UNAVAILABLE: 'Сжатие недоступно: команда /compact не зарегистрирована (нужны плагины command-compact / compaction-basic и перезапуск dsh web).',
    COMPACT_STARTED: 'Сжатие истории начато…\nОно занимает один ход модели, новые сообщения встают в очередь; результат придёт сюда.',
    COMPACT_BUSY: 'В сессии идёт работа (или она занята сжатием) — сжать нельзя. Дождитесь конца хода (или /stop) и повторите.',
    COMPACT_INFLIGHT: 'Эта сессия уже сжимается — подождите, результат придёт сюда.',
    COMPACT_NOTHING: 'Сжатие завершено: сжимать нечего (история слишком короткая либо нет участка, который можно безопасно свернуть).',
    COMPACT_DONE(n, tokens) {
        return `Сжатие завершено: объединено записей — ${n} (~${tokens} токенов). Контекст сокращён, работа продолжается.`;
    },
    COMPACT_CANCELLED: 'Сжатие отменено (сессия не изменилась).',
    COMPACT_CHANGED: 'Сжатие не удалось: история изменилась во время процесса (сессия не тронута). Повторите.',
    COMPACT_SUMMARY_FAILED: 'Сжатие не удалось: не получилось построить корректную сводку (сессия не тронута). Повторите.',
    COMPACT_COMMIT_FAILED: 'Сжатие завершилось не полностью: часть истории могла измениться. Проверьте состояние сессии и повторите.',
    COMPACT_PERSIST_FAILED: 'Сжатие выполнено, но сохранить не удалось. Проверьте хранилище и права, затем повторите.',
    COMPACT_FAILED(detail) {
        const tip = 'Сжатие не удалось.';
        if (!detail)
            return tip;
        return `${tip}\nПодробности: ${detail}`;
    },
    GONE: 'Привязанная сессия больше недоступна. Отправьте /sessions заново.',
    MEDIA_UNSUPPORTED: 'Этот тип сообщения пока не поддерживается (текст и картинки png/jpeg/webp/gif; голос, видео и файлы — через Web).',
    IMAGE_MODEL_UNSUPPORTED: 'Текущая модель не принимает изображения. Переключитесь на мультимодальную (в Web или через /model) и повторите.',
    IMAGE_FAILED(detail) {
        const tip = 'Не удалось отправить изображение.';
        if (!detail)
            return tip;
        return `${tip}\nПодробности: ${detail}`;
    },
    LAST_FAILED: 'Не удалось прочитать прошлый диалог. Проверьте привязку и доступность dsh web / apiProxy.',
    MODEL_UNAVAILABLE(detail) {
        const tip = 'Не удалось получить список моделей. Убедитесь, что сессия привязана и в dsh web загружен host-apiproxy.';
        if (!detail)
            return tip;
        return `${tip}\nПодробности: ${detail}`;
    },
    MODEL_UNROUTABLE(current) {
        return `Текущая модель недоступна: ${current}\nНастройте провайдера в Web и повторите /model.`;
    },
    MODEL_EMPTY(current) {
        return `Сейчас: ${current}\nНет моделей для переключения.`;
    },
    MODEL_SET(selected) {
        return `Модель переключена: ${selected}\nДействует со следующего хода.`;
    },
    RICH_USAGE: 'Использование: /rich on (rich-рендер, нужен свежий клиент) | /rich off (HTML, по умолчанию) | /rich (текущее состояние)',
    RICH_STATE(mode) {
        return mode === 'rich'
            ? 'Режим рендера: rich (on). Если клиент показывает «не поддерживается», отправьте /rich off.'
            : 'Режим рендера: HTML (off). В новых клиентах можно включить /rich on.';
    },
    RICH_SET(mode) {
        return mode === 'rich'
            ? 'Включён rich-рендер (для этого чата). Нужен свежий клиент Telegram, старые покажут «не поддерживается».'
            : 'Включён HTML-рендер (для этого чата) — отображается во всех версиях клиента.';
    },
    MODEL_FAILED(detail) {
        const tip = 'Не удалось переключить модель. Повторите позже или смените её в Web.';
        if (!detail)
            return tip;
        return `${tip}\nПодробности: ${detail}`;
    },
    unknown(command) {
        return `Неизвестная команда ${command}. Отправьте /help со списком команд.`;
    },
};
export function parseCommand(text) {
    if (!text.startsWith('/'))
        return { type: 'plain', text };
    const raw = text.split(/\s+/)[0] ?? text;
    const command = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
    switch (command) {
        case '/start':
            return { type: 'start', text };
        case '/help':
            return { type: 'help', text };
        case '/sessions':
        case '/list':
            return { type: 'sessions', text };
        case '/last':
        case '/context':
            return { type: 'last', text };
        case '/model':
            return { type: 'model', text };
        case '/status':
            return { type: 'status', text };
        case '/compact':
            return { type: 'compact', text };
        case '/rich':
        case '/render':
        case '/setting': {
            const arg = text.split(/\s+/)[1]?.toLowerCase();
            return { type: 'rich', text, arg };
        }
        case '/unbind':
        case '/disconnect':
            return { type: 'unbind', text };
        case '/stop':
        case '/halt':
            return { type: 'stop', text };
        case '/mission':
        case '/todos':
            return { type: 'mission', text };
        case '/new':
        case '/create':
            return { type: 'new', text };
        case '/cancel':
            return { type: 'cancel', text };
        default:
            return { type: 'unknown', command, text };
    }
}
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export const BIND_CB_PREFIX = 'bind:';
/** Inline button: fetch last Q/A for the bound session. */
export const LAST_CB = 'last';
