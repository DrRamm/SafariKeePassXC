# Задачи и приёмка

- [ ] PK-1, PK-4. На минимальной поддерживаемой macOS 26.5 проверить точку подключения в Safari, строгую CSP и ранний вызов. Записать версию Safari, рабочий manifest и результат в design.md.
- [ ] PK-2, PK-3, PK-6. Добавить обе нативные команды. На тестовой базе проверить первую операцию без предварительного открытия popup, успех и оба уровня ошибок. Зафиксировать обезличенные синтетические fixtures, соответствующие проверенному формату.
- [ ] PK-5. Реализовать изолированный канал и проверки в background.js. Проверить чужой RP ID, публичный суффикс, подделку origin, корректный родительский RP ID и попытку отправить get-logins через тот же канал.
- [ ] PK-2, PK-3. Реализовать WebAuthn-адаптер. Проверить BufferSource со смещением, toJSON, регистрацию, вход, исключённый ключ, выбор записи, allowCredentials и ранее созданный ключ.
- [ ] PK-1, PK-4, PK-6. Добавить переключатель и диагностику в popup, переводы en/de. Проверить стандартный Safari при выключении, conditional mediation, iframe и неподдерживаемые параметры.
- [ ] PK-5, PK-6. Проверить две вкладки с одновременными запросами, навигацию, отмену и тайм-аут, закрытую базу и остановленный мост. Исключить доставку позднего ответа другому запросу и повтор регистрации.
- [ ] PK-7. В подписанной сборке закрыть окно, создать passkey на тестовом сайте, выйти и войти. Проверить получение серверной сессии, заполнение, сохранение пароля и TOTP.
- [ ] Запустить xcodebuild test для схемы SafariKeePassXC. Записать версию macOS, Safari и KeePassXC, результат автоматических и ручных проверок. Невыполненные проверки оставить открытыми.

## Статус

Реализовано в коде:

- `passkeys-page.js` — адаптер основного мира, сериализация BufferSource, восстановление credential/response, `toJSON`, fallback в Safari.
- `passkeys-content.js` — изолированный канал, тайм-ауты, abort, `pagehide`, отбрасывание поздних ответов.
- `background.js` — HTTPS/origin/frame/настройка/RP ID, публичные суффиксы.
- `PasskeyRequest.swift`, `BridgeRouter`, `KeePassXCClient` — обе нативные команды, `test-associate` на новой сессии, передача `keys`.
- Popup: переключатель по умолчанию выключен, диагностика, en/de.
- Тесты: `tests/passkeys-background.test.mjs` (11), `tests/passkeys-page.test.mjs` (15, на fixtures) и `tests/passkeys-content.test.mjs` (9); `PasskeyRequestTests` (9).

Автоматические проверки (2026-11-25, macOS 27.2.1, Safari 27.2, Xcode 27.2):

- `node --test tests/` — 35/35 pass.
- `xcodebuild build -scheme SafariKeePassXC ... CODE_SIGNING_ALLOWED=NO` — BUILD SUCCEEDED.
- `xcodebuild test -scheme SafariKeePassXC ... CODE_SIGNING_ALLOWED=NO` — все тесты `PasskeyRequestTests`, `KeePassXCCryptoTests`, `CompleteJSONObjectsTests`, `ProtocolErrorTests`, `BridgeTokenVerifyTests`, `DataHexExtensionTests`, `UnixSocketConnectionTests` прошли. `AssociationStoreTests` падают без подписи (Keychain), UI-runner не стартует без подписи. С подписью эти проверки нужно повторить.
- Ручной прогон адаптера в Safari 27.2 на локальной странице: `world: "MAIN"` внедряется, `create`/`get` перехватываются; типичная регистрация и типичный вход дают `create:keepassxc`/`get:keepassxc`, `attestation: "direct"` → `create:safari:attestation`, `mediation: "conditional"` → `get:safari:mediation`, `hints` больше не отключают перехват.

Ручная проверка на реальном сайте (2026-11-25, Safari 27.2, KeePassXC 2.7.9): вход по passkey на `x.com` прошёл через KeePassXC. По ходу проверки найдено и исправлено: неизвестные WebAuthn-расширения отключали перехват (x.com присылает такое расширение) — теперь они игнорируются, кроме `support: "required"`.

Эксплуатационные грабли, важные для проверки:

- После замены `.app` Safari сбрасывает доступ расширения к сайтам: нужно заново выдать «Разрешить на всех сайтах» и перезапустить Safari, иначе content-скрипты не внедряются и passkey молча уходит в Safari.
- Если в системе осталась вторая копия приложения (например, `build/Build/Products/Release/...`), Safari может запустить appex из неё: popup будет «висеть» на «…», а passkeys не работать. Держите только `/Applications/SafariKeePassXC.app`.

Не выполнено (требует Safari 26.5, KeePassXC и тестового сайта):

- Ручная проверка внедрения MAIN/document_start на строгой CSP и раннем вызове на macOS 26.5.
- Регистрация/вход через KeePassXC, выбор записи, allowCredentials, ранее созданный ключ.
- iframe, conditional mediation, неподдерживаемые опции.
- Две вкладки, навигация, отмена, тайм-аут, закрытая база, остановленный мост.
- PK-7 в подписанной сборке с закрытым окном приложения.
