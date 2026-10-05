# Изображения Chrome Web Store

- `screenshot-light.png` — 1280 × 800, светлая тема.
- `screenshot-dark.png` — 1280 × 800, тёмная тема.
- `promo-small.png` — 440 × 280, маленькое промо.
- Иконка магазина: `extension/icons/icon-128.png` — 128 × 128.

Скриншоты содержат снимки настоящего popup Chrome из `screenshots/popup-native-*.png` и поясняющий текст. Это композиции для карточки магазина, а не новые экраны расширения. Все изображения используют локальные ресурсы и системный шрифт macOS.

Пересоздание: `npm run store:assets` (нужен Playwright). Для воспроизведения шрифта используйте macOS. Исходник композиции — `store/artwork.html`.
