# Архитектура и контракты

Сайт → page-world адаптер → изолированный content script → background.js → SafariWebExtensionHandler → HostBridgeConnection → BridgeServer → KeePassXCClient → KeePassXC. Переиспользовать аутентификацию локального моста, AssociationStore и зашифрованный протокол KeePassXC. Закрытый ключ остаётся в базе KeePassXC.

## Safari

На macOS 26.5 первым шагом проверить внедрение в основной мир в document_start, включая страницу со строгой CSP и вызов из первого скрипта. Внести проверенную декларацию в manifest. Сохранить оригинальные create/get и вызывать с исходным this и аргументами для сценариев PK-4. Пока читается асинхронная настройка, сохранить ранний запрос и затем выбрать обработчик. Ограничить первую версию базовыми операциями регистрации и входа. Запросы с неподдерживаемыми расширениями WebAuthn передавать Safari целиком.

Изолированный обработчик проверяет источник сообщения, тип операции и структуру. Не передавать произвольные имена команд из страницы. Background проверяет настройку, sender.tab, верхний frameId и HTTPS sender.url. Origin вычислять только из sender.url. Проверять RP ID по правилам WebAuthn, включая родительский домен и публичные суффиксы. Простого endsWith недостаточно.

Каждому вызову назначать уникальный ID. Ответ возвращать исходному документу. Отписывать обработчики при завершении, тайм-ауте, abort и pagehide. Поздние ответы отбрасывать. AbortSignal завершает Promise своей причиной. Отказ и тайм-аут дают NotAllowedError, недопустимый RP ID — SecurityError, исключённый ключ — InvalidStateError.

## Нативный мост

BridgeRouter допускает passkeys-register и passkeys-get с origin и объектом publicKey. KeePassXCClient загружает сопряжение, вызывает ensureSession и проверяет test-associate на новой сессии даже без предварительного status из popup. Передаёт sendEncrypted полезную нагрузку с origin, publicKey и keys из AssociationStore. Обрабатывать внешнюю ошибку протокола и внутреннюю ошибку response. После потери ответа регистрацию не повторять.

Контракт ниже показывает содержимое расшифрованной команды и значимые поля результата. Угловые скобки обозначают синтетические значения; бинарные поля кодируются base64url без padding.

    → {"action":"passkeys-register","origin":"https://login.example.com","keys":[{"id":"<association>","key":"<public-key>"}],"publicKey":{"rp":{"id":"example.com","name":"Example"},"user":{"id":"AQI","name":"alice","displayName":"Alice"},"challenge":"<challenge>","pubKeyCredParams":[{"type":"public-key","alg":-7}]}}
    ← {"response":{"id":"<credential-id>","type":"public-key","response":{"clientDataJSON":"<data>","attestationObject":"<attestation>"}}}

    → {"action":"passkeys-get","origin":"https://login.example.com","keys":[{"id":"<association>","key":"<public-key>"}],"publicKey":{"rpId":"example.com","challenge":"<fresh-challenge>","allowCredentials":[{"type":"public-key","id":"<credential-id>"}]}}
    ← {"response":{"id":"<credential-id>","type":"public-key","response":{"clientDataJSON":"<data>","authenticatorData":"<data>","signature":"<signature>","userHandle":"AQI"}}}

Сериализовать challenge, user.id и ID в allowCredentials/excludeCredentials с учётом byteOffset и byteLength каждого BufferSource. Восстанавливать rawId, бинарные поля attestation/assertion, userHandle либо null, методы соответствующего ответа, getClientExtensionResults() и toJSON(). Проверить структуру вложенного ответа и коды ошибок по закреплённому upstream и фактической версии KeePassXC до фиксации тестовых данных.

## Исходные реализации

- [Команды и протокол KeePassXC 2.7.9](https://github.com/keepassxreboot/keepassxc/blob/2.7.9/src/browser/BrowserAction.cpp)
- [Адаптер WebAuthn официального расширения](https://github.com/keepassxreboot/keepassxc-browser/blob/9d27471ab0b8f913f1b7d6b36b74cbcba0170613/keepassxc-browser/content/passkeys.js)
- [Преобразование параметров](https://github.com/keepassxreboot/keepassxc-browser/blob/9d27471ab0b8f913f1b7d6b36b74cbcba0170613/keepassxc-browser/content/passkeys-utils.js)
- [Сценарии регистрации и выбора записи KeePassium](https://github.com/keepassium/KeePassium/blob/e651df4f89b0b8550371566ca9aa55a964d2904e/KeePassium%20AutoFill/entry-finder/EntryFinderCoordinator%2Bpasskeys.swift)

## Реализация

Проверка точки подключения в Safari выполнена на macOS 27.2.1, Safari 27.2: `world: "MAIN"` в manifest внедряет адаптер на `document_start` до первых скриптов страницы и не блокируется строгим CSP страницы (`script-src 'self'`). Проверено локальной страницей: `navigator.credentials.create` заменён, `document.documentElement.dataset.kpxcPasskeysPage === "enabled"`. Дополнительно `passkeys-content.js` вставляет адаптер как `<script src=browser.runtime.getURL(...)>` на случай, если Safari проигнорирует `world: "MAIN"`. Прогон на минимальной поддерживаемой macOS 26.5 остаётся открытым.

```json
"content_scripts": [
  { "js": ["content.js"], "matches": ["http://*/*", "https://*/*"], "all_frames": false },
  { "js": ["passkeys-page.js"], "matches": ["https://*/*"],
    "run_at": "document_start", "all_frames": false, "world": "MAIN" },
  { "js": ["passkeys-content.js"], "matches": ["https://*/*"],
    "run_at": "document_start", "all_frames": false }
]
```

Канал:

- `passkeys-page.js` работает в основном мире, сохраняет оригинальные `create`/`get` и вызывает их с исходным `this` и аргументами. Ранние вызовы ждут `passkeysEnabled` из `storage.local`; при выключенной настройке, в iframe, при conditional/silent mediation, `attestationFormats` и неподдерживаемых алгоритмах вызов целиком уходит в Safari.
- `passkeys-content.js` — изолированный посредник. Принимает только `passkeys-register`, `passkeys-get` и `abort`, проверяет структуру, ведёт карту запросов, отбрасывает поздние ответы, снимает таймеры на `pagehide`/`unload`.
- `background.js` берёт origin только из `sender.url`, требует HTTPS, `sender.tab` и верхний `frameId`, проверяет настройку и RP ID, затем отправляет нативной стороне только `{id, action, origin, publicKey}`.
- Настройка `passkeysEnabled` по умолчанию отсутствует, то есть выключена. Popup различает остановленный мост, отсутствие сопряжения и KeePassXC старее 2.7.7.

RP ID проверяется как registrable domain suffix: `rpId` равен хосту или его суффиксу по границе точки и не является публичным суффиксом. Список публичных суффиксов лежит в `Resources/public-suffixes.js` (сгенерирован из PSL, ICANN + private, включая wildcard/exception; обновляется `scripts/update-public-suffixes.py`). Wildcard-правило `*.X` применяется только к домену с одним дополнительным слева label: `foo.ck` — публичный суффикс, `bar.foo.ck` — registrable. `localhost` обрабатывается отдельно. IP-адреса, порты, схемы и не-ASCII имена отклоняются.

`attestation: "direct"` и `"enterprise"` передаются Safari: KeePassXC 2.7.9 всё равно формирует `fmt: "none"`, и сайт, проверяющий attestation, отверг бы такую регистрацию. `"indirect"` перехватывается: WebAuthn допускает для него `fmt: "none"`. `attestationFormats` и неподдерживаемые алгоритмы уходят в Safari. `hints` игнорируются: это лишь подсказка о предпочитаемом UI, локальный passkey остаётся корректным ответом. Неизвестные WebAuthn-расширения тоже игнорируются, а не отключают перехват: по спецификации они необязательны, клиент обязан их пропустить. Исключение — расширение с `support: "required"` (например, `largeBlob`): его без поддержки удовлетворить нельзя, такой запрос уходит в Safari. В KeePassXC передаются только `credProps` и `uvm`.

Каждый вызов `create`/`get` записывает решение в `document.documentElement.dataset.kpxcPasskeysLastDecision` (`create:keepassxc`, `create:safari:attestation`, `get:safari:mediation`, `create:safari:background-fallback`, …). Popup читает его через `passkeys-diagnostic` и показывает причину fallback. Без этого молчаливый уход в Safari выглядит как неработающее расширение: системный диалог Safari с KeePassium — это признак того, что перехват не произошёл, а не того, что приложение должно быть в списке провайдеров (оно им не является).

Событие `kpxc-passkeys-setting` доступно скриптам страницы: иначе page-world адаптер не узнает настройку до первого вызова. Это осознанный компромисс; событие не содержит секретов и лишь сообщает, включён ли мост.

Коды ошибок KeePassXC (`response.errorCode`) отображаются так: 27/28 — `SecurityError`, 29/34/35 — `NotSupportedError`, 36 — `SyntaxError`, 32/33 — `TypeError`, 21 — `InvalidStateError`, остальные — `NotAllowedError`. Отказ, тайм-аут, отмена, навигация и потеря моста также дают `NotAllowedError`/`AbortError`.

Нативный мост: `BridgeRouter` допускает только `passkeys-register`/`passkeys-get`, `PasskeyRequest` повторно проверяет origin, challenge, user.id и список алгоритмов. `KeePassXCClient` загружает `AssociationStore`, вызывает `ensureSession`, на новой сессии делает `test-associate`, затем отправляет `origin`, `publicKey` и `keys`. Внутренний `response` возвращается без изменений, чтобы страница сама сопоставила `errorCode`. Повторной регистрации после потери ответа нет.

Синтетические fixtures: `fixtures/passkeys-register-request.json`, `passkeys-register-response.json`, `passkeys-get-request.json`, `passkeys-get-response.json`, `passkeys-error-excluded.json`. Формат сверен с KeePassXC 2.7.9 (`BrowserAction.cpp`, `BrowserPasskeys.cpp`, `BrowserPasskeysClient.cpp`, `PasskeyUtils.cpp`) и `keepassxc-browser` `passkeys.js`/`passkeys-utils.js`.
