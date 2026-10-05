# Публикация Go Through Tabs

## GitHub

1. Репозиторий проекта: [CrazyMeizy/Go-Through-Tabs](https://github.com/CrazyMeizy/Go-Through-Tabs).
2. Используется лицензия MIT. В репозитории находятся расширение, документация, тесты и материалы магазина; `dist/`, зависимости, временные отчёты и ключи не публикуются.
3. Создайте выпуск `v1.1.1` и приложите архив ручной установки и его SHA-256. Исходные файлы доступны непосредственно в папке `extension/`.
4. Сайт проекта: [репозиторий](https://github.com/CrazyMeizy/Go-Through-Tabs). Поддержка: [Issues](https://github.com/CrazyMeizy/Go-Through-Tabs/issues). Политика конфиденциальности: [PRIVACY.md](https://github.com/CrazyMeizy/Go-Through-Tabs/blob/main/PRIVACY.md).

Локальный Git-коммит должен использовать выбранное вами имя и публичный либо GitHub noreply email. Не добавляйте в открытый репозиторий рабочие адреса, токены, приватные ключи и личные URL браузера.

## Архив для Chrome Web Store

```sh
npm test
npm run package
```

Загружайте **`dist/go-through-tabs-chrome-web-store-1.1.1.zip`**. В нём `manifest.json` находится в корне. `go-through-tabs-1.1.1.zip` с внешней папкой предназначен для ручной установки.

Правило структуры и предел описания в 132 символа: [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare). Текущая версия — Manifest V3, со всеми локальными ресурсами и без удалённого кода.

## Карточка магазина

Используйте подготовленные тексты из [store/LISTING.md](store/LISTING.md), изображения из `store/assets/` и иконку `extension/icons/icon-128.png`. Основной язык первой версии — русский; поддерживаемая платформа — Chrome на macOS. Укажите это в описании явно.

Минимальные материалы: иконка 128 × 128, скриншот 1280 × 800 и маленькое промо 440 × 280. Подробности: [информация карточки](https://developer.chrome.com/docs/webstore/cws-dashboard-listing/) и [изображения](https://developer.chrome.com/docs/webstore/images).

## Privacy practices

Тексты назначения, обоснования разрешений и работы с данными находятся в `store/LISTING.md`. Укажите обработку **Web history**: адреса и метаданные навигации обрабатываются локально. Не объявляйте «расширение не обрабатывает пользовательские данные»: отсутствие сервера не отменяет локальную обработку.

Укажите публичный URL политики. Все разрешения используются текущими функциями, а не будущими возможностями. Не отмечайте удалённый код: скрипты и ресурсы входят в архив.

Правила: [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/) и [FAQ о локальной обработке данных](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

## Отправка

1. Откройте [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Зарегистрируйте аккаунт разработчика, если его ещё нет. Регистрация включает разовый взнос; принятие условий и оплату выполняет владелец аккаунта. Включите двухэтапную проверку Google.
3. Создайте новый элемент, загрузите магазинный ZIP, заполните карточку, Privacy practices, видимость и материалы для проверки.
4. В Test instructions вставьте сценарий из `store/LISTING.md`; вход в аккаунт сайта для проверки не нужен.
5. Отправьте на проверку. Для контролируемого первого запуска выберите публикацию вручную после одобрения.

Репозиторий GitHub и загрузка черновика не заменяют одобрение магазина. Для последующих загрузок кода повышайте `version` в manifest и package.json, пересобирайте архив и обновляйте изменившиеся сведения.

Источники: [регистрация](https://developer.chrome.com/docs/webstore/register/), [публикация](https://developer.chrome.com/docs/webstore/publish), [обновления](https://developer.chrome.com/docs/webstore/update).
