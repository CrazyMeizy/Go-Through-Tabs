# Материалы карточки Chrome Web Store

Название: **Go Through Tabs**. Основной язык: русский. Предлагаемая категория: Productivity / Workflow & Planning (выберите соответствующий доступный пункт панели).

## Описание

`⌘ [` и `⌘ ]` продолжают историю между вкладками, открытыми по ссылкам.

Go Through Tabs для Chrome на macOS соединяет привычные переходы назад/вперёд с переходами между связанными вкладками.

Назад: сначала предыдущие страницы текущей вкладки; у начала её истории вкладка закрывается, и вы возвращаетесь к исходной.

Вперёд: сначала следующие страницы; в точке возврата закрытая вкладка восстанавливается справа от исходной. Если сессия Chrome доступна, восстанавливается и её внутренняя история.

Работают вложенные цепочки вкладок, ссылки, открытые в фоне, SPA-переходы и фрагменты. Ручное переключение вкладок не добавляет шагов истории. В popup можно отключить специальные сочетания; светлая и тёмная темы следуют системе.

Для Command + клик и средней кнопки возврат доступен даже до первого ответа сайта. Используется временная локальная страница, которая заменяется сайтом без дополнительного шага истории. Этот способ не передаёт исходный HTTP Referer; штатное открытие через меню Chrome сохраняется. Для других способов открытия скобки доступны после появления первого документа.

Данные истории обрабатываются только локально в Chrome: адреса страниц, сведения о записях истории и связи вкладок. Нет серверов, аналитики и передачи этих данных разработчику.

Chrome 120+ на macOS. Интерфейс на русском языке. Нужен фокус на HTTP/HTTPS-странице. Адресная строка, служебные страницы Chrome и встроенный PDF сохраняют штатное поведение браузера. Инкогнито не поддерживается. Перенос вкладки в другое окно разрывает связь.

Связи хранятся до полного закрытия Chrome. Новая навигация после возврата назад сбрасывает прежнюю ветку вперёд. Если закрытая сессия недоступна, открывается сохранённый URL с уведомлением.

После установки перезагрузите существующие веб-вкладки; связи, созданные раньше, неизвестны расширению. Отключите другие расширения, которые меняют эти сочетания или добавляют служебные записи истории.

## Single purpose

Enable back/forward navigation across linked tabs in Chrome on macOS using Command + [ and Command + ], closing a child tab at its history boundary and restoring it beside its source when moving forward.

## Permissions justification

| Разрешение | Текст для панели |
|---|---|
| tabs | Read tab URLs and metadata, activate the source tab, close a linked child at its history boundary, and position restored tabs. Used only for the visible linked-history navigation feature. |
| webNavigation | Identify tabs created by links and observe navigation/history-entry changes, including accessible frame history, so native page traversal happens before crossing a linked-tab boundary. |
| sessions | Restore the specific child-tab session closed by the extension, preserving Chrome's internal history when available. Read recently closed sessions to identify that exact tab rather than reopening an unrelated tab. |
| storage | Hold tab relationships, navigation identifiers, restoration records and the enabled setting in chrome.storage.session between service-worker wakeups. No account synchronization or external storage is used. |
| scripting | Install the packaged keyboard/navigation observer into existing eligible tabs when the extension is installed or updated. Only local content.js is injected; no remotely hosted code is executed. |
| http://*/*, https://*/* | Recognize the shortcuts and observe navigation on arbitrary websites, including supported frames and links across different domains. Access limited to one active tab would lose the source/child relationship and restoration anchors needed for this feature. No page text or form values are read. |

## Data usage

**Web history:** locally processed URLs (including query/fragment), closed-tab titles, history-entry identifiers and tab relationships. Used only for the disclosed navigation feature. Stored in session memory; not transmitted to the developer, used for advertising or sold. Other listed categories such as personal communications, authentication information, financial data and website content are not accessed as page/form content by this extension.

**Remote code:** No. All runtime JavaScript, CSS and images are included in the uploaded package.

**Privacy policy URL:** https://github.com/CrazyMeizy/Go-Through-Tabs/blob/main/PRIVACY.md

**Homepage:** https://github.com/CrazyMeizy/Go-Through-Tabs

**Support:** https://github.com/CrazyMeizy/Go-Through-Tabs/issues

Read and confirm the developer certifications yourself against this policy and current behavior.

## Test instructions

Chrome 120+ on macOS. No login or credentials required. Interface language: Russian.

1. Load any regular HTTP/HTTPS page. If it was open before installation, reload it.
2. Open a link in a new tab using Command-click, the context menu or target=_blank. Make one extra page navigation in the child tab.
3. Press Command + [ once to traverse native history back. Press it again at the child's first entry: the child closes and its source becomes active.
4. Press Command + ] at that source entry: the child restores, becomes active and appears immediately to the source's right. Another Command + ] traverses the child's native history forward.
5. For source history A0 → A1 → A2 and child B0 → B1, verify back sequence B1 → B0 → A2 → A1 → A0 and forward sequence A0 → A1 → A2 → B0 → B1.
6. Open the extension popup. Turn its switch off/on and reopen it to confirm the state. Shortcuts require focus on the page rather than the address bar. In a restored-session fallback, a notice explains that only the saved URL was reopened.
7. Command-click a link to a server that delays its first response. Before any response arrives, activate the child and press Command + [: it closes immediately. Command + ] reopens the target next to its source; the pending child can close again before its response. Once loaded, Back closes at the first actual website entry, with no temporary loading-page step. There is no lost-history notice for a never-committed website.

Tabs without a known live source are not automatically closed. Incognito, Chrome internal pages, Chrome Web Store and the built-in PDF viewer are outside the supported scope. Disable other extensions intercepting these shortcuts during review.
