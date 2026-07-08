import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const socket = io(API_URL, { autoConnect: true });

function blankOption(text = '', correct = false) {
  return { localId: crypto.randomUUID(), text, correct };
}

function blankQuestion() {
  return {
    localId: crypto.randomUUID(),
    type: 'text',
    text: '',
    imageUrl: '',
    allowMultiple: false,
    timeLimitSeconds: 30,
    options: [blankOption(), blankOption(), blankOption(), blankOption()]
  };
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Ошибка запроса к серверу.');
  }
  return data;
}

function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [role, setRole] = useState('organizer');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('org@demo.ru');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = mode === 'login'
        ? { email, password }
        : { name, email, password, role };
      const data = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      localStorage.setItem('quiz-token', data.token);
      onAuth(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="hero-card">
        <div>
          <Badge tone="primary">Realtime MVP</Badge>
          <h1>Платформа для квизов в реальном времени</h1>
          <p>
            Организатор создаёт квиз и запускает комнату, участники подключаются по коду,
            отвечают только во время демонстрации вопроса и видят общий лидерборд.
          </p>
        </div>
        <div className="hero-grid">
          <div><strong>Socket.IO</strong><span>живые комнаты</span></div>
          <div><strong>React</strong><span>быстрый интерфейс</span></div>
          <div><strong>Node.js</strong><span>серверная логика</span></div>
          <div><strong>История</strong><span>сохранение результатов</span></div>
        </div>
      </section>

      <form className="auth-card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Вход</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Регистрация</button>
        </div>

        {mode === 'register' && (
          <>
            <label>
              Имя
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Имя" />
            </label>
            <label>
              Роль
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="organizer">Организатор</option>
                <option value="participant">Участник</option>
              </select>
            </label>
          </>
        )}

        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="org@demo.ru" />
        </label>
        <label>
          Пароль
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="demo1234" />
        </label>

        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={loading}>{loading ? 'Проверяем...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>

        <div className="demo-hint">
          <p><strong>Организатор:</strong> org@demo.ru / demo1234</p>
          <p><strong>Участник:</strong> user@demo.ru / demo1234</p>
        </div>
      </form>
    </main>
  );
}

function Header({ user, onLogout }) {
  return (
    <header className="app-header">
      <div>
        <h1>Quiz Realtime</h1>
        <p>MVP для проведения квизов по коду комнаты</p>
      </div>
      <div className="profile-box">
        <span>{user.name}</span>
        <Badge tone={user.role === 'organizer' ? 'primary' : 'success'}>{user.role === 'organizer' ? 'Организатор' : 'Участник'}</Badge>
        <button className="ghost" onClick={onLogout}>Выйти</button>
      </div>
    </header>
  );
}

function QuizForm({ token, onCreated }) {
  const [form, setForm] = useState({
    title: 'Новый квиз',
    category: 'Общее',
    rules: 'За правильный ответ начисляется 100 баллов и бонус за скорость.',
    questionTimeSeconds: 30,
    questions: [blankQuestion()]
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateQuestion(index, patch) {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question)
    }));
  }

  function updateOption(questionIndex, optionIndex, patch) {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        return {
          ...question,
          options: question.options.map((option, optIndex) => optIndex === optionIndex ? { ...option, ...patch } : option)
        };
      })
    }));
  }

  function markCorrect(questionIndex, optionIndex, checked) {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        const options = question.options.map((option, optIndex) => {
          if (question.allowMultiple) {
            return optIndex === optionIndex ? { ...option, correct: checked } : option;
          }
          return { ...option, correct: optIndex === optionIndex };
        });
        return { ...question, options };
      })
    }));
  }

  function setAllowMultiple(questionIndex, allowMultiple) {
    setForm((current) => ({
      ...current,
      questions: current.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        const options = allowMultiple ? question.options : question.options.map((option, optIndex) => ({ ...option, correct: optIndex === 0 }));
        return { ...question, allowMultiple, options };
      })
    }));
  }

  async function createQuiz(event) {
    event.preventDefault();
    setError('');
    setSaving(true);

    try {
      const payload = {
        ...form,
        questionTimeSeconds: Number(form.questionTimeSeconds),
        questions: form.questions.map((question) => ({
          ...question,
          timeLimitSeconds: Number(question.timeLimitSeconds || form.questionTimeSeconds),
          options: question.options.filter((option) => option.text.trim()).map((option) => ({
            text: option.text,
            correct: option.correct
          }))
        }))
      };

      const data = await api('/api/quizzes', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload)
      });
      setForm({
        title: 'Новый квиз',
        category: 'Общее',
        rules: 'За правильный ответ начисляется 100 баллов и бонус за скорость.',
        questionTimeSeconds: 30,
        questions: [blankQuestion()]
      });
      onCreated(data.quiz);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel quiz-form" onSubmit={createQuiz}>
      <div className="panel-title">
        <div>
          <h2>Создать квиз</h2>
          <p>Настройте вопросы, правила и время на ответ.</p>
        </div>
      </div>

      <div className="form-grid">
        <label>
          Название
          <input value={form.title} onChange={(event) => updateField('title', event.target.value)} />
        </label>
        <label>
          Категория
          <input value={form.category} onChange={(event) => updateField('category', event.target.value)} />
        </label>
        <label>
          Время по умолчанию, сек.
          <input type="number" min="5" max="180" value={form.questionTimeSeconds} onChange={(event) => updateField('questionTimeSeconds', event.target.value)} />
        </label>
      </div>

      <label>
        Правила
        <textarea value={form.rules} onChange={(event) => updateField('rules', event.target.value)} />
      </label>

      <div className="questions-list">
        {form.questions.map((question, questionIndex) => (
          <article className="question-editor" key={question.localId}>
            <div className="question-editor-head">
              <h3>Вопрос {questionIndex + 1}</h3>
              <button
                type="button"
                className="ghost danger"
                disabled={form.questions.length === 1}
                onClick={() => setForm((current) => ({ ...current, questions: current.questions.filter((_, index) => index !== questionIndex) }))}
              >
                Удалить
              </button>
            </div>

            <div className="form-grid">
              <label>
                Тип вопроса
                <select value={question.type} onChange={(event) => updateQuestion(questionIndex, { type: event.target.value })}>
                  <option value="text">Текстовый</option>
                  <option value="image">С изображением</option>
                </select>
              </label>
              <label>
                Время, сек.
                <input type="number" min="5" max="180" value={question.timeLimitSeconds} onChange={(event) => updateQuestion(questionIndex, { timeLimitSeconds: event.target.value })} />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={question.allowMultiple} onChange={(event) => setAllowMultiple(questionIndex, event.target.checked)} />
                Можно несколько ответов
              </label>
            </div>

            <label>
              Текст вопроса
              <input value={question.text} onChange={(event) => updateQuestion(questionIndex, { text: event.target.value })} />
            </label>

            {question.type === 'image' && (
              <label>
                URL изображения
                <input value={question.imageUrl} onChange={(event) => updateQuestion(questionIndex, { imageUrl: event.target.value })} placeholder="https://..." />
              </label>
            )}

            <div className="options-editor">
              {question.options.map((option, optionIndex) => (
                <div className="option-row" key={option.localId}>
                  <input
                    type={question.allowMultiple ? 'checkbox' : 'radio'}
                    name={`correct-${question.localId}`}
                    checked={option.correct}
                    onChange={(event) => markCorrect(questionIndex, optionIndex, event.target.checked)}
                    title="Правильный ответ"
                  />
                  <input value={option.text} onChange={(event) => updateOption(questionIndex, optionIndex, { text: event.target.value })} placeholder={`Вариант ${optionIndex + 1}`} />
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="actions-row">
        <button type="button" className="secondary" onClick={() => setForm((current) => ({ ...current, questions: [...current.questions, blankQuestion()] }))}>Добавить вопрос</button>
        <button className="primary" disabled={saving}>{saving ? 'Сохраняем...' : 'Сохранить квиз'}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function QuizCard({ quiz, onLaunch, onDelete }) {
  return (
    <article className="quiz-card">
      <div>
        <Badge tone="neutral">{quiz.category}</Badge>
        <h3>{quiz.title}</h3>
        <p>{quiz.rules}</p>
      </div>
      <div className="quiz-meta">
        <span>{quiz.questions.length} вопрос(ов)</span>
        <span>{quiz.questionTimeSeconds} сек.</span>
      </div>
      <div className="actions-row">
        <button className="primary" onClick={() => onLaunch(quiz.id)}>Запустить комнату</button>
        <button className="ghost danger" onClick={() => onDelete(quiz.id)}>Удалить</button>
      </div>
    </article>
  );
}

function OrganizerRoom({ token, room, onClose }) {
  const [state, setState] = useState(room);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [closed, setClosed] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    function handleRoomState(nextState) {
      setState(nextState);
    }
    function handleQuestion(question) {
      setCurrentQuestion(question);
      setClosed(null);
    }
    function handleQuestionClosed(payload) {
      setClosed(payload);
    }
    function handleFinished(payload) {
      setState(payload.room);
      setCurrentQuestion(null);
    }

    socket.emit('joinRoom', { roomCode: room.code, token }, (response) => {
      if (!response?.ok) setError(response?.message || 'Не удалось войти в комнату.');
      if (response?.room) setState(response.room);
      if (response?.currentQuestion) setCurrentQuestion(response.currentQuestion);
    });

    socket.on('roomState', handleRoomState);
    socket.on('question', handleQuestion);
    socket.on('questionClosed', handleQuestionClosed);
    socket.on('quizFinished', handleFinished);

    return () => {
      socket.off('roomState', handleRoomState);
      socket.off('question', handleQuestion);
      socket.off('questionClosed', handleQuestionClosed);
      socket.off('quizFinished', handleFinished);
    };
  }, [room.code, token]);

  function emitControl(eventName) {
    setError('');
    socket.emit(eventName, { roomCode: state.code, token }, (response) => {
      if (!response?.ok) setError(response?.message || 'Команда не выполнена.');
    });
  }

  return (
    <section className="panel live-panel">
      <div className="panel-title">
        <div>
          <Badge tone="primary">Комната {state.code}</Badge>
          <h2>{state.quizTitle}</h2>
          <p>Участники подключаются по этому коду.</p>
        </div>
        <button className="ghost" onClick={onClose}>Закрыть панель</button>
      </div>

      <div className="room-code">{state.code}</div>

      <div className="actions-row">
        {state.status === 'lobby' && <button className="primary" onClick={() => emitControl('startQuiz')}>Начать квиз</button>}
        {state.status === 'running' && <button className="secondary" onClick={() => emitControl('closeQuestion')}>Закрыть вопрос</button>}
        {state.status === 'question_closed' && <button className="primary" onClick={() => emitControl('nextQuestion')}>Следующий вопрос</button>}
        {state.status !== 'finished' && <button className="ghost danger" onClick={() => emitControl('finishQuiz')}>Завершить квиз</button>}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="live-grid">
        <div className="live-question">
          <h3>Текущий вопрос</h3>
          {currentQuestion ? (
            <div>
              <p className="question-progress">{currentQuestion.index + 1} / {currentQuestion.total}</p>
              <h2>{currentQuestion.text}</h2>
              {currentQuestion.imageUrl && <img className="question-image" src={currentQuestion.imageUrl} alt="Картинка к вопросу" />}
              <ul>
                {currentQuestion.options.map((option) => <li key={option.id}>{option.text}</li>)}
              </ul>
            </div>
          ) : (
            <EmptyState title="Вопрос не открыт" text="Нажмите кнопку запуска или перехода к следующему вопросу." />
          )}

          {closed && (
            <div className="answer-stats">
              <h3>Статистика ответа</h3>
              {closed.stats.map((item) => (
                <div key={item.optionId} className={item.correct ? 'stat-line correct' : 'stat-line'}>
                  <span>{item.text}</span>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <Leaderboard leaderboard={state.leaderboard} participants={state.participants} />
      </div>
    </section>
  );
}

function Leaderboard({ leaderboard = [], participants = [] }) {
  const rows = leaderboard.length ? leaderboard : participants.map((item) => ({ ...item, answersCorrect: 0, totalAnswered: 0 }));

  return (
    <div className="leaderboard">
      <h3>Лидерборд</h3>
      {rows.length === 0 ? (
        <EmptyState title="Пока никого нет" text="Участники появятся после подключения по коду комнаты." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Участник</th>
              <th>Баллы</th>
              <th>Верно</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.userId}>
                <td>{index + 1}</td>
                <td>{row.name}</td>
                <td>{row.score}</td>
                <td>{row.answersCorrect ?? 0}/{row.totalAnswered ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OrganizerDashboard({ token }) {
  const [quizzes, setQuizzes] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  async function loadData() {
    try {
      const [quizData, historyData] = await Promise.all([
        api('/api/quizzes', { headers: authHeaders(token) }),
        api('/api/history', { headers: authHeaders(token) })
      ]);
      setQuizzes(quizData.quizzes);
      setHistory(historyData.organized);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function launchQuiz(quizId) {
    setError('');
    try {
      const data = await api('/api/rooms', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ quizId })
      });
      setActiveRoom(data.room);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteQuiz(quizId) {
    if (!confirm('Удалить квиз?')) return;
    try {
      await api(`/api/quizzes/${quizId}`, {
        method: 'DELETE',
        headers: authHeaders(token)
      });
      setQuizzes((current) => current.filter((quiz) => quiz.id !== quizId));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="dashboard-grid">
      <section>
        <QuizForm token={token} onCreated={(quiz) => setQuizzes((current) => [quiz, ...current])} />
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Мои квизы</h2>
            <p>Запускайте комнату и приглашайте участников по коду.</p>
          </div>
          <button className="ghost" onClick={loadData}>Обновить</button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="cards-list">
          {quizzes.length === 0 ? <EmptyState title="Квизов нет" text="Создайте первый квиз через форму слева." /> : quizzes.map((quiz) => (
            <QuizCard key={quiz.id} quiz={quiz} onLaunch={launchQuiz} onDelete={deleteQuiz} />
          ))}
        </div>
      </section>

      {activeRoom && <OrganizerRoom token={token} room={activeRoom} onClose={() => setActiveRoom(null)} />}

      <HistoryPanel title="История проведённых квизов" items={history} />
    </div>
  );
}

function ParticipantDashboard({ token }) {
  const [code, setCode] = useState('');
  const [room, setRoom] = useState(null);
  const [question, setQuestion] = useState(null);
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(null);
  const [history, setHistory] = useState([]);

  async function loadHistory() {
    try {
      const data = await api('/api/history', { headers: authHeaders(token) });
      setHistory(data.participated);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  useEffect(() => {
    function handleRoomState(nextRoom) {
      if (room && nextRoom.code === room.code) setRoom(nextRoom);
    }
    function handleQuestion(nextQuestion) {
      setQuestion(nextQuestion);
      setClosed(null);
      setSelected([]);
      setMessage('');
    }
    function handleClosed(payload) {
      setClosed(payload);
      setQuestion(null);
      setMessage('Вопрос закрыт. Смотрите правильный ответ и лидерборд.');
    }
    function handleFinished(payload) {
      setRoom(payload.room);
      setQuestion(null);
      setMessage('Квиз завершён. Итоговый лидерборд сохранён в истории.');
      loadHistory();
    }

    socket.on('roomState', handleRoomState);
    socket.on('question', handleQuestion);
    socket.on('questionClosed', handleClosed);
    socket.on('quizFinished', handleFinished);

    return () => {
      socket.off('roomState', handleRoomState);
      socket.off('question', handleQuestion);
      socket.off('questionClosed', handleClosed);
      socket.off('quizFinished', handleFinished);
    };
  }, [room, token]);

  function joinRoom(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    const roomCode = code.trim().toUpperCase();
    socket.emit('joinRoom', { roomCode, token }, (response) => {
      if (!response?.ok) {
        setError(response?.message || 'Не удалось подключиться к комнате.');
        return;
      }
      setRoom(response.room);
      setQuestion(response.currentQuestion);
      setMessage('Вы подключились к комнате. Ждите вопрос от организатора.');
    });
  }

  function toggleOption(optionId) {
    if (!question) return;
    if (question.allowMultiple) {
      setSelected((current) => current.includes(optionId) ? current.filter((item) => item !== optionId) : [...current, optionId]);
      return;
    }
    setSelected([optionId]);
  }

  function submitAnswer() {
    if (!question || !room) return;
    setError('');
    setMessage('');
    socket.emit('submitAnswer', {
      roomCode: room.code,
      questionId: question.id,
      optionIds: selected,
      token
    }, (response) => {
      if (!response?.ok) {
        setError(response?.message || 'Не удалось отправить ответ.');
        return;
      }
      setMessage(response.message || 'Ответ отправлен.');
    });
  }

  return (
    <div className="participant-layout">
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Подключиться к квизу</h2>
            <p>Введите код комнаты, который показал организатор.</p>
          </div>
        </div>
        <form className="join-form" onSubmit={joinRoom}>
          <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Например: A1B2C3" />
          <button className="primary">Войти</button>
        </form>
        {error && <p className="error">{error}</p>}
        {message && <p className="success-message">{message}</p>}
      </section>

      <section className="panel play-panel">
        {room ? (
          <>
            <div className="panel-title">
              <div>
                <Badge tone="primary">Комната {room.code}</Badge>
                <h2>{room.quizTitle}</h2>
                <p>{room.rules}</p>
              </div>
              <Badge tone={room.status === 'running' ? 'success' : 'neutral'}>{room.status}</Badge>
            </div>

            {question ? (
              <div className="question-play">
                <p className="question-progress">Вопрос {question.index + 1} из {question.total}</p>
                <h2>{question.text}</h2>
                {question.imageUrl && <img className="question-image" src={question.imageUrl} alt="Картинка к вопросу" />}
                <div className="answers-grid">
                  {question.options.map((option) => (
                    <button
                      key={option.id}
                      className={selected.includes(option.id) ? 'answer selected' : 'answer'}
                      onClick={() => toggleOption(option.id)}
                    >
                      {option.text}
                    </button>
                  ))}
                </div>
                <button className="primary" disabled={selected.length === 0} onClick={submitAnswer}>Отправить ответ</button>
              </div>
            ) : closed ? (
              <div className="answer-stats">
                <h3>Правильный ответ</h3>
                {closed.stats.map((item) => (
                  <div key={item.optionId} className={item.correct ? 'stat-line correct' : 'stat-line'}>
                    <span>{item.text}</span>
                    <strong>{item.correct ? 'верно' : `${item.count} ответ(ов)`}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="Ожидание вопроса" text="Организатор управляет показом вопросов в реальном времени." />
            )}
          </>
        ) : (
          <EmptyState title="Вы ещё не в комнате" text="Введите код комнаты и дождитесь запуска квиза." />
        )}
      </section>

      {room && <Leaderboard leaderboard={room.leaderboard} participants={room.participants} />}
      <HistoryPanel title="История участия" items={history} />
    </div>
  );
}

function HistoryPanel({ title, items }) {
  return (
    <section className="panel history-panel">
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p>Результаты сохраняются после завершения комнаты.</p>
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState title="История пустая" text="Завершите хотя бы один квиз, чтобы здесь появились результаты." />
      ) : (
        <div className="history-list">
          {items.map((item) => (
            <article key={item.id} className="history-item">
              <div>
                <h3>{item.quizTitle}</h3>
                <p>Комната {item.roomCode} · {new Date(item.endedAt).toLocaleString('ru-RU')}</p>
              </div>
              <Leaderboard leaderboard={item.leaderboard} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('quiz-token'));
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(token));

  const isOrganizer = useMemo(() => user?.role === 'organizer', [user]);

  useEffect(() => {
    async function loadMe() {
      if (!token) return;
      try {
        const data = await api('/api/me', { headers: authHeaders(token) });
        setUser(data.user);
      } catch {
        localStorage.removeItem('quiz-token');
        setToken(null);
      } finally {
        setChecking(false);
      }
    }
    loadMe();
  }, [token]);

  function handleAuth(nextUser, nextToken) {
    setUser(nextUser);
    setToken(nextToken);
  }

  async function logout() {
    try {
      if (token) await api('/api/auth/logout', { method: 'POST', headers: authHeaders(token) });
    } catch {
      // Даже если сервер недоступен, локально пользователь должен выйти.
    }
    localStorage.removeItem('quiz-token');
    setToken(null);
    setUser(null);
  }

  if (checking) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!user) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  return (
    <div className="app-shell">
      <Header user={user} onLogout={logout} />
      {isOrganizer ? <OrganizerDashboard token={token} /> : <ParticipantDashboard token={token} />}
    </div>
  );
}
