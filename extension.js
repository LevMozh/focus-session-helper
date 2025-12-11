// extension.js
// Основной файл расширения VS Code.

/**
 * @fileoverview
 * Расширение Focus Session Helper для Visual Studio Code.
 * Реализует простой таймер фокус-сессий и статистику за день.
 */

const vscode = require('vscode');

/**
 * Ключ в globalState, под которым хранится статистика фокус-сессий.
 * @type {string}
 */
const STORAGE_KEY_STATS = 'focusSession.stats';

/**
 * Интервал обновления таймера в миллисекундах.
 * @type {number}
 */
const TICK_INTERVAL_MS = 1000;

/**
 * Менеджер статистики по фокус-сессиям.
 * Отвечает за хранение и загрузку данных из глобального состояния VS Code.
 */
class StatsManager {
  /**
   * Создаёт новый экземпляр менеджера статистики.
   * @param {vscode.Memento} globalState - Объект глобального состояния расширения.
   */
  constructor(globalState) {
    /**
     * Глобальное состояние VS Code, предоставленное контекстом расширения.
     * @type {vscode.Memento}
     * @private
     */
    this._globalState = globalState;

    /**
     * Внутренний объект со статистикой.
     * Ключ — строка вида 'YYYY-MM-DD', значение — число миллисекунд фокусной работы.
     * @type {{[date: string]: number}}
     * @private
     */
    this._stats = this._loadStats();
  }

  /**
   * Загружает статистику из globalState.
   * Если данных нет, создаёт пустой объект.
   * @returns {{[date: string]: number}} Объект со статистикой.
   * @private
   */
  _loadStats() {
    const raw = this._globalState.get(STORAGE_KEY_STATS);
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    return raw;
  }

  /**
   * Сохраняет статистику в globalState.
   * @returns {Thenable<void>} Промис, который разрешается после завершения записи.
   * @private
   */
  _saveStats() {
    return this._globalState.update(STORAGE_KEY_STATS, this._stats);
  }

  /**
   * Увеличивает статистику за текущий день на указанное количество миллисекунд.
   * @param {number} deltaMs - Количество миллисекунд, которое нужно добавить.
   * @returns {Thenable<void>} Промис, разрешающийся после сохранения.
   */
  addFocusedMilliseconds(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return Promise.resolve();
    }
    const key = getTodayKey();
    const prev = this._stats[key] || 0;
    this._stats[key] = prev + deltaMs;
    return this._saveStats();
  }

  /**
   * Возвращает количество миллисекунд фокусной работы за текущий день.
   * @returns {number} Количество миллисекунд для сегодняшней даты.
   */
  getTodayMilliseconds() {
    const key = getTodayKey();
    return this._stats[key] || 0;
  }

  /**
   * Возвращает человеко-читаемую строку со статистикой за текущий день.
   * @returns {string} Текст вида "Сегодня вы работали фокусно N мин M сек".
   */
  getTodayStatsMessage() {
    const ms = this.getTodayMilliseconds();
    if (ms <= 0) {
      return 'Сегодня статистика фокус-сессий отсутствует.';
    }
    const formatted = formatDuration(ms);
    return `Сегодня вы работали фокусно ${formatted}.`;
  }
}

/**
 * Менеджер фокус-сессий.
 * Управляет таймером, статус-баром и взаимодействует со StatsManager.
 */
class FocusSessionManager {
  /**
   * Создаёт новый экземпляр менеджера фокус-сессий.
   * @param {vscode.ExtensionContext} context - Контекст активированного расширения.
   */
  constructor(context) {
    /**
     * Контекст расширения VS Code.
     * @type {vscode.ExtensionContext}
     * @private
     */
    this._context = context;

    /**
     * Менеджер статистики, связанный с глобальным состоянием.
     * @type {StatsManager}
     * @private
     */
    this._statsManager = new StatsManager(context.globalState);

    /**
     * Элемент статус-бара, отображающий состояние таймера.
     * @type {vscode.StatusBarItem}
     * @private
     */
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this._statusBarItem.command = 'focusSession.pauseOrResume';

    /**
     * Идентификатор интервала таймера, возвращаемый setInterval.
     * @type {NodeJS.Timer | null}
     * @private
     */
    this._timer = null;

    /**
     * Остаток времени в миллисекундах.
     * @type {number}
     * @private
     */
    this._remainingMs = 0;

    /**
     * Флаг, показывающий активен ли таймер.
     * @type {boolean}
     * @private
     */
    this._running = false;

    /**
     * Время последнего тика таймера (в миллисекундах с начала эпохи).
     * Используется для расчёта прошедшего времени.
     * @type {number}
     * @private
     */
    this._lastTickTime = 0;
  }

  /**
   * Запускает новую фокус-сессию на заданное количество минут.
   * Если другая сессия уже идёт, она будет остановлена.
   * @param {number} minutes - Длительность новой сессии в минутах.
   */
  startNewSession(minutes) {
    const ms = minutesToMilliseconds(minutes);
    if (ms <= 0) {
      vscode.window.showWarningMessage(
        'Длительность сессии должна быть положительным числом минут.'
      );
      return;
    }

    this._stopTimerInternal(false);
    this._remainingMs = ms;
    this._running = true;
    this._lastTickTime = Date.now();

    this._statusBarItem.show();
    this._updateStatusBar();

    this._timer = setInterval(() => {
      this._onTick();
    }, TICK_INTERVAL_MS);
  }

  /**
   * Обрабатывает один тик таймера.
   * Вызывается каждый TICK_INTERVAL_MS миллисекунд.
   * @private
   */
  _onTick() {
    if (!this._running) {
      return;
    }
    const now = Date.now();
    const delta = now - this._lastTickTime;
    this._lastTickTime = now;
    this._remainingMs -= delta;

    if (this._remainingMs <= 0) {
      this._remainingMs = 0;
      this._updateStatusBar();
      this._finishSession();
    } else {
      this._updateStatusBar();
    }
  }

  /**
   * Обновляет текст статус-бара в зависимости от текущего состояния.
   * @private
   */
  _updateStatusBar() {
    if (!this._statusBarItem) {
      return;
    }
    if (this._remainingMs <= 0 && !this._running) {
      this._statusBarItem.text = '$(clock) Фокус-сессия не запущена';
      this._statusBarItem.tooltip = 'Нажмите, чтобы запустить новую сессию.';
      return;
    }
    const formatted = formatDuration(this._remainingMs);
    const state = this._running ? 'идёт' : 'на паузе';
    this._statusBarItem.text = `$(clock) Фокус: ${formatted} (${state})`;
    this._statusBarItem.tooltip =
      'Нажмите для паузы/возобновления или используйте команды Focus Session.';
  }

  /**
   * Переключает состояние таймера между паузой и активным режимом.
   * Если сессия не была запущена, отображает предупреждение.
   */
  togglePauseOrResume() {
    if (this._remainingMs <= 0 && !this._running) {
      vscode.window.showInformationMessage(
        'Фокус-сессия не запущена. Используйте команду "Focus Session: Start".'
      );
      return;
    }

    if (this._running) {
      this._running = false;
      this._updateStatusBar();
    } else {
      this._running = true;
      this._lastTickTime = Date.now();
      this._updateStatusBar();
    }
  }

  /**
   * Останавливает текущую сессию.
   * При необходимости скрывает статус-бар и сбрасывает состояние.
   * @param {boolean} showMessage - Показывать ли пользователю уведомление.
   */
  stopSession(showMessage) {
    this._stopTimerInternal(true);
    if (showMessage) {
      vscode.window.showInformationMessage('Фокус-сессия остановлена.');
    }
  }

  /**
   * Внутренний метод остановки таймера без показа сообщения.
   * @param {boolean} resetRemaining - Нужно ли сбросить оставшееся время.
   * @private
   */
  _stopTimerInternal(resetRemaining) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    if (resetRemaining) {
      this._remainingMs = 0;
    }
    this._updateStatusBar();
  }

  /**
   * Завершает сессию по достижении нулевого времени.
   * Добавляет затраченное время в статистику и показывает уведомление.
   * @private
   */
  _finishSession() {
    const now = Date.now();
    const last = this._lastTickTime;
    const spentMs = Math.max(0, now - last + TICK_INTERVAL_MS);

    this._running = false;
    this._stopTimerInternal(false);
    this._statusBarItem.text = '$(check) Фокус-сессия завершена!';
    this._statusBarItem.tooltip = 'Отличная работа!';

    this._statsManager
      .addFocusedMilliseconds(spentMs)
      .then(() => {
        vscode.window.showInformationMessage(
          'Фокус-сессия завершена! Время добавлено в статистику.'
        );
      })
      .catch((err) => {
        console.error('Не удалось сохранить статистику фокус-сессии:', err);
      });
  }

  /**
   * Показывает пользователю статистику за сегодняшний день.
   */
  showTodayStats() {
    const message = this._statsManager.getTodayStatsMessage();
    vscode.window.showInformationMessage(message);
  }

  /**
   * Освобождает ресурсы менеджера.
   * Вызывается при деактивации расширения.
   */
  dispose() {
    this._stopTimerInternal(false);
    if (this._statusBarItem) {
      this._statusBarItem.dispose();
    }
  }
}

/**
 * Преобразует значение в минутах в миллисекунды.
 * Нецелые значения допускаются.
 * @param {number} minutes - Количество минут.
 * @returns {number} Количество миллисекунд.
 */
function minutesToMilliseconds(minutes) {
  if (!Number.isFinite(minutes)) {
    return 0;
  }
  return minutes * 60 * 1000;
}

/**
 * Возвращает строку-ключ для текущей даты в формате YYYY-MM-DD.
 * Используется для хранения статистики по дням.
 * @returns {string} Ключ для сегодняшнего дня.
 */
function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Форматирует длительность в миллисекундах в строку "N мин M сек".
 * @param {number} ms - Длительность в миллисекундах.
 * @returns {string} Отформатированная строка.
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    ms = 0;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0 && seconds <= 0) {
    return '0 сек';
  }

  if (minutes <= 0) {
    return `${seconds} сек`;
  }
  if (seconds <= 0) {
    return `${minutes} мин`;
  }
  return `${minutes} мин ${seconds} сек`;
}

/**
 * Запрашивает у пользователя длительность сессии и запускает таймер.
 * Значение по умолчанию — 25 минут.
 * @param {FocusSessionManager} manager - Менеджер фокус-сессий.
 * @returns {Promise<void>} Промис, который разрешается после обработки ввода.
 */
async function askAndStartSession(manager) {
  const result = await vscode.window.showInputBox({
    prompt: 'Введите длительность фокус-сессии в минутах',
    placeHolder: 'Например, 25',
    value: '25',
    validateInput: (value) => validateMinutesInput(value)
  });

  if (result === undefined) {
    return;
  }

  const minutes = parseFloat(result.replace(',', '.'));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    vscode.window.showErrorMessage(
      'Некорректное значение минут. Введите положительное число.'
    );
    return;
  }

  manager.startNewSession(minutes);
}

/**
 * Валидирует введённое пользователем значение минут.
 * Возвращает строку с ошибкой для VS Code или null, если всё корректно.
 * @param {string} value - Значение, введённое пользователем.
 * @returns {string | null} Сообщение об ошибке или null при корректном вводе.
 */
function validateMinutesInput(value) {
  if (!value || !value.trim()) {
    return 'Необходимо ввести длительность сессии в минутах.';
  }
  const normalized = value.replace(',', '.');
  const number = parseFloat(normalized);
  if (!Number.isFinite(number)) {
    return 'Введите числовое значение.';
  }
  if (number <= 0) {
    return 'Длительность должна быть больше нуля.';
  }
  if (number > 480) {
    return 'Слишком большое значение. Укажите не больше 480 минут.';
  }
  return null;
}

/**
 * Глобальная переменная с экземпляром менеджера фокус-сессий.
 * Заполняется при активации расширения.
 * @type {FocusSessionManager | null}
 */
let globalManager = null;

/**
 * Функция активации расширения VS Code.
 * Вызывается один раз при первом запуске любой команды расширения.
 *
 * @param {vscode.ExtensionContext} context - Контекст активированного расширения.
 */
function activate(context) {
  globalManager = new FocusSessionManager(context);

  const startCommand = vscode.commands.registerCommand(
    'focusSession.start',
    async () => {
      if (!globalManager) {
        return;
      }
      await askAndStartSession(globalManager);
    }
  );

  const pauseResumeCommand = vscode.commands.registerCommand(
    'focusSession.pauseOrResume',
    () => {
      if (!globalManager) {
        return;
      }
      globalManager.togglePauseOrResume();
    }
  );

  const stopCommand = vscode.commands.registerCommand(
    'focusSession.stop',
    () => {
      if (!globalManager) {
        return;
      }
      globalManager.stopSession(true);
    }
  );

  const statsCommand = vscode.commands.registerCommand(
    'focusSession.showStats',
    () => {
      if (!globalManager) {
        return;
      }
      globalManager.showTodayStats();
    }
  );

  context.subscriptions.push(
    globalManager,
    startCommand,
    pauseResumeCommand,
    stopCommand,
    statsCommand
  );
}

/**
 * Функция деактивации расширения VS Code.
 * Вызывается при выгрузке расширения.
 */
function deactivate() {
  if (globalManager) {
    globalManager.dispose();
    globalManager = null;
  }
}

module.exports = {
  activate,
  deactivate
};
