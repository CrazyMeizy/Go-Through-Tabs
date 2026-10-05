# Go Through Tabs — политика конфиденциальности

Последнее обновление: 5 октября 2026 года. Относится к версии 1.1.1.

Go Through Tabs соединяет обычную историю страниц с переходами между вкладками, открытыми по ссылкам. Для этого расширение обрабатывает данные истории локально в Chrome.

## Какие данные обрабатываются

- Адреса HTTP/HTTPS-страниц, включая параметры адреса и фрагменты.
- Идентификаторы записей истории, вкладок, окон, доступных фреймов и закрытых сессий Chrome.
- Связи исходных и дочерних вкладок, порядок и точки восстановления.
- Заголовок закрываемой вкладки и её положение, необходимые сведения о текущей навигации.
- Состояние переключателя расширения и последнее уведомление.

Расширение не считывает текст страниц, значения форм, пароли, cookies, платёжные данные или содержимое `history.state`. Оно не записывает введённые пользователем клавиши: обработчик распознаёт только нужные сочетания Command со скобками. Восстановление вкладки использует встроенные сессии Chrome; само расширение не читает сохранённые браузером значения форм.

## Для чего используются данные

Только для переходов назад и вперёд между связанными вкладками, восстановления закрытой вкладки и сохранения состояния расширения между остановками фонового процесса.

Разрешения и история не используются для рекламы, профилирования, отслеживания интересов или каких-либо иных целей. Использование данных из API Chrome ограничено этой функцией и соответствует требованиям Limited Use политики пользовательских данных Chrome Web Store.

## Хранение и передача

Состояние расширения хранится в памяти браузера через `chrome.storage.session`. Оно не синхронизируется расширением с аккаунтом Google и очищается при полном закрытии браузера, отключении, удалении, обновлении или перезагрузке расширения средствами Chrome.

Переключатель в popup отключает специальные сочетания, но не очищает локальную историю связей. Для очистки состояния отключите расширение в `chrome://extensions/` либо полностью закройте Chrome.

У расширения нет сервера, аналитики, рекламных SDK, внешних скриптов или механизмов передачи этих данных разработчику и третьим лицам. Открытие или восстановление страницы приводит к обычной загрузке сайта самим Chrome; сайт обрабатывает такой запрос по своим правилам.

Собственная история посещений и список закрытых вкладок Chrome управляются настройками браузера. Удаление расширения не удаляет историю, которую хранит сам Chrome.

При открытии через Command + клик или среднюю кнопку временная локальная страница содержит целевой адрес во фрагменте URL. Это позволяет клавишам работать до ответа сайта и позволяет Chrome повторно открыть такой адрес. После успешной загрузки сайта временная запись заменяется. Если вкладку закрыть раньше, временный URL может остаться во встроенном списке закрытых сессий Chrome; он управляется браузером отдельно от `storage.session`. Фрагмент не передаётся сайту, расширение не отправляет исходный HTTP `Referer` при таком открытии.

## Контакт

Вопросы о конфиденциальности можно задать через [Issues Go Through Tabs](https://github.com/CrazyMeizy/Go-Through-Tabs/issues). Не включайте в публичные обращения приватные адреса, данные сессий или другой личный контент.

---

# Privacy policy (English)

Go Through Tabs processes browsing data locally to navigate back and forward across linked tabs. It handles page URLs (including query parameters and fragments), navigation-entry identifiers, tab/window/frame/session identifiers, tab relationships, restoration points, closed-tab titles and positions, the enabled setting and the latest notice.

It does not read page text, form values, passwords, cookies, payment details or `history.state`. It recognizes the required Command/bracket shortcuts rather than recording typed input. Tab restoration uses Chrome's built-in sessions; the extension does not read form data stored by Chrome.

Extension state is held in browser memory using `chrome.storage.session`. It is cleared when Chrome fully exits or the extension is disabled, removed, updated or reloaded by Chrome. Turning off the popup switch disables the special shortcuts but does not clear linked-history state. Disable the extension in `chrome://extensions/` or fully exit Chrome to clear that state.

The extension has no backend, analytics, advertising SDK or remote code. It does not send extension-held data to the developer or third parties, or synchronize that state with a Google account. Opening/restoring a page loads that website normally through Chrome. The website's own handling and Chrome's independent history/session storage are outside extension state.

Command-click and middle-click first open a temporary local extension page whose URL fragment holds the target URL, then replace that entry with the website. The temporary page keeps the keyboard handler available before the first server response. If closed before the website commits, its URL may remain in Chrome's own recently closed sessions. Chrome manages those independently of extension session storage. The fragment is not sent to the website; this opening path does not send the source page's HTTP Referer header.

Browsing data is used only for linked-tab navigation and restoration. It is not used for advertising, profiling or unrelated purposes. Use of data obtained through Chrome APIs follows the Chrome Web Store User Data Policy, including Limited Use restrictions.

Contact the maintainer through [Go Through Tabs Issues](https://github.com/CrazyMeizy/Go-Through-Tabs/issues). Do not include private browsing URLs or personal data in public reports.
