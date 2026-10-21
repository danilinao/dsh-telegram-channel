export declare const MSG: {
    readonly DENIED: "Нет доступа.";
    readonly WELCOME: string;
    readonly HELP: string;
    readonly NEED_BIND: "Сессия ещё не привязана. Отправьте /sessions и выберите одну.";
    readonly NO_SESSIONS: "Нет сессий для привязки (архивные и пустые скрыты). Откройте или продолжите диалог в Web (dsh web) и снова отправьте /sessions.";
    readonly NO_SESSIONS_IN_WS: (title: string) => string;
    /** @deprecated use NO_SESSIONS */
    readonly NO_LIVE: "Нет сессий для привязки. Откройте или продолжите диалог в Web (dsh web) и снова отправьте /sessions.";
    readonly PICKER_STALE: "Список устарел — отправьте /sessions заново.";
    readonly RESUME_FAILED: "Не удалось привязать сессию (ошибка resume). Проверьте, что она есть в Web, или откройте её на компьютере и повторите.";
    readonly BOUND: (label: string) => string;
    readonly UNBOUND: "Привязка снята. Сессия на компьютере продолжает работать.";
    readonly STATUS_NONE: "Сейчас нет привязанной сессии. Отправьте /sessions и выберите.";
    readonly STATUS_BOUND: (label: string) => string;
    readonly STATUS_BOUND_COLD: (label: string) => string;
    readonly COMPACT_USAGE: "Использование: /compact (без параметров — сжать историю привязанной сессии, сократить контекст)";
    readonly COMPACT_UNAVAILABLE: "Сжатие недоступно: команда /compact не зарегистрирована (нужны плагины command-compact / compaction-basic и перезапуск dsh web).";
    readonly COMPACT_STARTED: "Сжатие истории начато…\nОно занимает один ход модели, новые сообщения встают в очередь; результат придёт сюда.";
    readonly COMPACT_BUSY: "В сессии идёт работа (или она занята сжатием) — сжать нельзя. Дождитесь конца хода (или /stop) и повторите.";
    readonly COMPACT_INFLIGHT: "Эта сессия уже сжимается — подождите, результат придёт сюда.";
    readonly COMPACT_NOTHING: "Сжатие завершено: сжимать нечего (история слишком короткая либо нет участка, который можно безопасно свернуть).";
    readonly COMPACT_DONE: (n: number, tokens: number) => string;
    readonly COMPACT_CANCELLED: "Сжатие отменено (сессия не изменилась).";
    readonly COMPACT_CHANGED: "Сжатие не удалось: история изменилась во время процесса (сессия не тронута). Повторите.";
    readonly COMPACT_SUMMARY_FAILED: "Сжатие не удалось: не получилось построить корректную сводку (сессия не тронута). Повторите.";
    readonly COMPACT_COMMIT_FAILED: "Сжатие завершилось не полностью: часть истории могла измениться. Проверьте состояние сессии и повторите.";
    readonly COMPACT_PERSIST_FAILED: "Сжатие выполнено, но сохранить не удалось. Проверьте хранилище и права, затем повторите.";
    readonly COMPACT_FAILED: (detail?: string) => string;
    readonly ARCHIVE_USAGE: "Использование: /archive — убрать текущую сессию в архив (из меню и из Web она исчезнет, работа останавливается)";
    readonly ARCHIVE_NONE: "Сейчас нет привязанной сессии — архивировать нечего.";
    readonly ARCHIVE_DONE: (label: string) => string;
    readonly ARCHIVE_FAILED: (detail?: string) => string;
    readonly NOTIFY_USAGE: "Использование: /notify on — все события, /notify errors — только ошибки, /notify off — выключить";
    readonly NOTIFY_STATE: (mode: "all" | "errors" | "off") => string;
    readonly NOTIFY_SET: (mode: "all" | "errors" | "off") => string;
    readonly NEWPROJECT_USAGE: "Использование: /newproject <путь к папке> [ | Название]\nПример: /newproject /home/alexey/projects/my-game | My Game";
    readonly NEWPROJECT_PROMPT: "Отправьте путь к папке проекта. Можно с названием: /home/alexey/projects/my-game | My Game";
    readonly NEWPROJECT_CREATED: (title: string, path: string) => string;
    readonly NEWPROJECT_FAILED: (detail?: string) => string;
    readonly NEWPROJECT_CANCELLED: "Добавление проекта отменено.";
    readonly NO_PROJECTS: "В реестре пока нет ни одной рабочей области. Создайте первую: /newproject <путь к папке>";
    readonly NO_SESSIONS_IN_WS_EMPTY: (title: string) => string;
    readonly GONE: "Привязанная сессия больше недоступна. Отправьте /sessions заново.";
    readonly MEDIA_UNSUPPORTED: "Этот тип сообщения пока не поддерживается (текст и картинки png/jpeg/webp/gif; голос, видео и файлы — через Web).";
    readonly IMAGE_MODEL_UNSUPPORTED: "Текущая модель не принимает изображения. Переключитесь на мультимодальную (в Web или через /model) и повторите.";
    readonly IMAGE_FAILED: (detail?: string) => string;
    readonly LAST_FAILED: "Не удалось прочитать прошлый диалог. Проверьте привязку и доступность dsh web / apiProxy.";
    readonly MODEL_UNAVAILABLE: (detail?: string) => string;
    readonly MODEL_UNROUTABLE: (current: string) => string;
    readonly MODEL_EMPTY: (current: string) => string;
    readonly MODEL_SET: (selected: string) => string;
    readonly RICH_USAGE: "Использование: /rich on (rich-рендер, нужен свежий клиент) | /rich off (HTML, по умолчанию) | /rich (текущее состояние)";
    readonly RICH_STATE: (mode: "rich" | "html") => string;
    readonly RICH_SET: (mode: "rich" | "html") => string;
    readonly MODEL_FAILED: (detail?: string) => string;
    readonly unknown: (command: string) => string;
};
export type ParsedCommand = {
    type: 'start';
    text: string;
} | {
    type: 'help';
    text: string;
} | {
    type: 'sessions';
    text: string;
} | {
    type: 'last';
    text: string;
} | {
    type: 'model';
    text: string;
} | {
    type: 'status';
    text: string;
} | {
    type: 'compact';
    text: string;
} | {
    type: 'rich';
    text: string;
    arg?: string;
} | {
    type: 'unbind';
    text: string;
} | {
    type: 'stop';
    text: string;
} | {
    type: 'mission';
    text: string;
} | {
    type: 'new';
    text: string;
} | {
    type: 'cancel';
    text: string;
} | {
    type: 'archive';
    text: string;
} | {
    type: 'notify';
    text: string;
    arg?: string;
} | {
    type: 'newproject';
    text: string;
    arg?: string;
} | {
    type: 'projects';
    text: string;
} | {
    type: 'archived';
    text: string;
} | {
    type: 'history';
    text: string;
    arg?: string;
} | {
    type: 'unknown';
    command: string;
    text: string;
} | {
    type: 'plain';
    text: string;
};
export declare function parseCommand(text: string): ParsedCommand;
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export declare const BIND_CB_PREFIX = "bind:";
/** Inline button: fetch last Q/A for the bound session. */
export declare const LAST_CB = "last";
