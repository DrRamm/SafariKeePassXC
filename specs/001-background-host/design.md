# Конструкция

Сейчас AppDelegate запускает BridgeServer при старте. MainWindow перехватывает miniaturize и вызывает moveToMenuBar. Этот метод скрывает окно, включает activation policy accessory и создаёт NSStatusItem. ViewController вызывает его также после открытия настроек Safari.

1. Сосредоточить переход в фон в одном методе AppDelegate на главном потоке. Запомнить главное окно, вызвать orderOut и переключиться на accessory. Удалить NSStatusItem и обработчик его кнопки.
2. Направить закрытие и сворачивание MainWindow в этот метод. При перехвате windowShouldClose скрывать окно и возвращать false. Сохранить штатный путь завершения приложения. В Main.storyboard добавить команды окна для ⌘W и ⌘M с действиями performClose: и performMiniaturize: через First Responder.
3. После успешного открытия настроек Safari вызвать тот же метод из ViewController.
4. При applicationShouldHandleReopen вернуть regular, активировать приложение и вызвать makeKeyAndOrderFront для сохранённого окна. Мост принадлежит процессу на всём протяжении его жизни. Существующие настройки подключения, токен и сопряжение используются и в фоне.
