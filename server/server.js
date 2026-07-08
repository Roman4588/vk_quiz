import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { readDb, updateDb, ensureDb } from './database.js';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '3mb' }));

const rooms = new Map();

function id(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

function roomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function getUserByToken(token) {
  if (!token) return null;
  const db = readDb();
  const session = db.tokens.find((item) => item.token === token);
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ message: 'Нужна авторизация.' });
  }
  req.user = user;
  req.token = token;
  next();
}

function organizerRequired(req, res, next) {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ message: 'Доступно только организатору.' });
  }
  next();
}

function safeQuiz(quiz, includeCorrect = false) {
  return {
    ...quiz,
    questions: quiz.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => includeCorrect ? option : ({ id: option.id, text: option.text }))
    }))
  };
}

function currentQuestionPayload(room) {
  const question = room.quiz.questions[room.currentIndex];
  if (!question) return null;

  return {
    id: question.id,
    type: question.type,
    text: question.text,
    imageUrl: question.imageUrl,
    allowMultiple: question.allowMultiple,
    options: question.options.map((option) => ({ id: option.id, text: option.text })),
    index: room.currentIndex,
    total: room.quiz.questions.length,
    deadline: room.deadline,
    timeLimitSeconds: question.timeLimitSeconds || room.quiz.questionTimeSeconds
  };
}

function leaderboard(room) {
  return [...room.participants.values()]
    .map((participant) => ({
      userId: participant.userId,
      name: participant.name,
      score: participant.score,
      answersCorrect: participant.answersCorrect,
      totalAnswered: participant.totalAnswered
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    quizId: room.quiz.id,
    quizTitle: room.quiz.title,
    category: room.quiz.category,
    rules: room.quiz.rules,
    questionTimeSeconds: room.quiz.questionTimeSeconds,
    currentIndex: room.currentIndex,
    totalQuestions: room.quiz.questions.length,
    participants: [...room.participants.values()].map((participant) => ({
      userId: participant.userId,
      name: participant.name,
      score: participant.score
    })),
    leaderboard: leaderboard(room)
  };
}

function exactSameSet(answerIds, correctIds) {
  const answer = [...new Set(answerIds)].sort();
  const correct = [...new Set(correctIds)].sort();
  if (answer.length !== correct.length) return false;
  return answer.every((value, index) => value === correct[index]);
}

function questionStats(room, question) {
  const answers = room.answers.get(question.id) || new Map();
  const counts = new Map(question.options.map((option) => [option.id, 0]));

  for (const answer of answers.values()) {
    for (const optionId of answer.optionIds) {
      counts.set(optionId, (counts.get(optionId) || 0) + 1);
    }
  }

  return question.options.map((option) => ({
    optionId: option.id,
    text: option.text,
    correct: option.correct,
    count: counts.get(option.id) || 0
  }));
}

function closeCurrentQuestion(room) {
  if (room.status !== 'running') return null;

  const question = room.quiz.questions[room.currentIndex];
  if (!question || room.closedQuestionIds.has(question.id)) return null;

  const correctIds = question.options.filter((option) => option.correct).map((option) => option.id);
  const answers = room.answers.get(question.id) || new Map();

  for (const [userId, answer] of answers.entries()) {
    const participant = room.participants.get(userId);
    if (!participant) continue;

    const isCorrect = exactSameSet(answer.optionIds, correctIds);
    const timeLeft = Math.max(0, room.deadline - answer.submittedAt);
    const timeBonus = isCorrect ? Math.ceil(timeLeft / 1000) * 5 : 0;

    participant.totalAnswered += 1;
    if (isCorrect) {
      participant.answersCorrect += 1;
      participant.score += 100 + timeBonus;
    }
  }

  room.closedQuestionIds.add(question.id);
  room.status = 'question_closed';
  clearTimeout(room.timer);

  const payload = {
    questionId: question.id,
    correctOptionIds: correctIds,
    stats: questionStats(room, question),
    leaderboard: leaderboard(room)
  };

  io.to(room.code).emit('questionClosed', payload);
  io.to(room.code).emit('roomState', publicRoom(room));
  return payload;
}

function saveRoomResult(room) {
  if (room.resultSaved) return;
  room.resultSaved = true;

  updateDb((db) => {
    db.results.push({
      id: id('result_'),
      quizId: room.quiz.id,
      quizTitle: room.quiz.title,
      roomCode: room.code,
      organizerId: room.organizerId,
      startedAt: room.startedAt,
      endedAt: nowIso(),
      leaderboard: leaderboard(room)
    });
  });
}

function finishRoom(room) {
  if (room.status === 'running') {
    closeCurrentQuestion(room);
  }
  room.status = 'finished';
  clearTimeout(room.timer);
  saveRoomResult(room);
  io.to(room.code).emit('quizFinished', { leaderboard: leaderboard(room), room: publicRoom(room) });
  io.to(room.code).emit('roomState', publicRoom(room));
}

function openQuestion(room, nextIndex) {
  if (nextIndex >= room.quiz.questions.length) {
    finishRoom(room);
    return;
  }

  room.currentIndex = nextIndex;
  room.status = 'running';
  const question = room.quiz.questions[room.currentIndex];
  const seconds = Number(question.timeLimitSeconds || room.quiz.questionTimeSeconds || 30);
  room.deadline = Date.now() + seconds * 1000;

  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    const actualRoom = rooms.get(room.code);
    if (!actualRoom || actualRoom.status !== 'running') return;
    closeCurrentQuestion(actualRoom);
  }, seconds * 1000 + 300);

  io.to(room.code).emit('question', currentQuestionPayload(room));
  io.to(room.code).emit('roomState', publicRoom(room));
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function validateQuizInput(body) {
  const errors = [];

  if (!body.title || String(body.title).trim().length < 3) {
    errors.push('Название квиза должно быть не короче 3 символов.');
  }

  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    errors.push('Добавьте хотя бы один вопрос.');
  }

  for (const [index, question] of (body.questions || []).entries()) {
    if (!question.text || String(question.text).trim().length < 3) {
      errors.push(`Вопрос №${index + 1}: заполните текст вопроса.`);
    }
    if (!Array.isArray(question.options) || question.options.length < 2) {
      errors.push(`Вопрос №${index + 1}: нужно минимум 2 варианта ответа.`);
    }
    if (!question.options?.some((option) => option.correct)) {
      errors.push(`Вопрос №${index + 1}: отметьте правильный ответ.`);
    }
    if (question.type === 'image' && !question.imageUrl) {
      errors.push(`Вопрос №${index + 1}: для изображения нужен URL картинки.`);
    }
  }

  return errors;
}

function makeQuizFromBody(body, ownerId) {
  return {
    id: id('quiz_'),
    ownerId,
    title: String(body.title || '').trim(),
    category: String(body.category || 'Без категории').trim(),
    rules: String(body.rules || 'За правильный ответ начисляется 100 баллов и бонус за скорость.').trim(),
    questionTimeSeconds: Number(body.questionTimeSeconds || 30),
    createdAt: nowIso(),
    questions: body.questions.map((question, questionIndex) => ({
      id: id('q_'),
      type: question.type === 'image' ? 'image' : 'text',
      text: String(question.text || '').trim(),
      imageUrl: String(question.imageUrl || '').trim(),
      allowMultiple: Boolean(question.allowMultiple),
      timeLimitSeconds: Number(question.timeLimitSeconds || body.questionTimeSeconds || 30),
      position: questionIndex + 1,
      options: question.options.map((option) => ({
        id: id('opt_'),
        text: String(option.text || '').trim(),
        correct: Boolean(option.correct)
      }))
    }))
  };
}

function seedDemoData() {
  ensureDb();
  updateDb((db) => {
    if (db.users.length > 0) return;

    const orgPass = hashPassword('demo1234');
    const userPass = hashPassword('demo1234');
    const organizerId = id('user_');
    const participantId = id('user_');

    db.users.push({
      id: organizerId,
      name: 'Демо Организатор',
      email: 'org@demo.ru',
      role: 'organizer',
      salt: orgPass.salt,
      passwordHash: orgPass.hash,
      createdAt: nowIso()
    });

    db.users.push({
      id: participantId,
      name: 'Демо Участник',
      email: 'user@demo.ru',
      role: 'participant',
      salt: userPass.salt,
      passwordHash: userPass.hash,
      createdAt: nowIso()
    });

    db.quizzes.push({
      id: id('quiz_'),
      ownerId: organizerId,
      title: 'Демо-квиз по веб-разработке',
      category: 'Frontend',
      rules: 'Один вопрос показывается всем участникам одновременно. Ответ засчитывается только до окончания таймера.',
      questionTimeSeconds: 25,
      createdAt: nowIso(),
      questions: [
        {
          id: id('q_'),
          type: 'text',
          text: 'Какой тег используется для подключения JavaScript-файла?',
          imageUrl: '',
          allowMultiple: false,
          timeLimitSeconds: 25,
          position: 1,
          options: [
            { id: id('opt_'), text: '<script>', correct: true },
            { id: id('opt_'), text: '<style>', correct: false },
            { id: id('opt_'), text: '<link>', correct: false },
            { id: id('opt_'), text: '<section>', correct: false }
          ]
        },
        {
          id: id('q_'),
          type: 'text',
          text: 'Какие технологии относятся к frontend-разработке?',
          imageUrl: '',
          allowMultiple: true,
          timeLimitSeconds: 30,
          position: 2,
          options: [
            { id: id('opt_'), text: 'HTML', correct: true },
            { id: id('opt_'), text: 'CSS', correct: true },
            { id: id('opt_'), text: 'JavaScript', correct: true },
            { id: id('opt_'), text: 'Бензиновый двигатель', correct: false }
          ]
        }
      ]
    });
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: nowIso() });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role } = req.body;
  const cleanEmail = normalizeEmail(email);

  if (!name || !cleanEmail || !password) {
    return res.status(400).json({ message: 'Заполните имя, email и пароль.' });
  }
  if (!['organizer', 'participant'].includes(role)) {
    return res.status(400).json({ message: 'Выберите роль organizer или participant.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Пароль должен быть не короче 6 символов.' });
  }

  const result = updateDb((db) => {
    if (db.users.some((user) => user.email === cleanEmail)) {
      return { error: 'Пользователь с таким email уже существует.' };
    }

    const pass = hashPassword(password);
    const user = {
      id: id('user_'),
      name: String(name).trim(),
      email: cleanEmail,
      role,
      salt: pass.salt,
      passwordHash: pass.hash,
      createdAt: nowIso()
    };
    const token = crypto.randomUUID();

    db.users.push(user);
    db.tokens.push({ token, userId: user.id, createdAt: nowIso() });
    return { token, user: publicUser(user) };
  });

  if (result.error) return res.status(409).json({ message: result.error });
  res.status(201).json(result);
});

app.post('/api/auth/login', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const db = readDb();
  const user = db.users.find((item) => item.email === email);

  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ message: 'Неверный email или пароль.' });
  }

  const token = crypto.randomUUID();
  updateDb((mutableDb) => {
    mutableDb.tokens.push({ token, userId: user.id, createdAt: nowIso() });
  });

  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  updateDb((db) => {
    db.tokens = db.tokens.filter((item) => item.token !== req.token);
  });
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/quizzes', authRequired, (req, res) => {
  const db = readDb();
  const quizzes = req.user.role === 'organizer'
    ? db.quizzes.filter((quiz) => quiz.ownerId === req.user.id)
    : db.quizzes;

  res.json({ quizzes: quizzes.map((quiz) => safeQuiz(quiz, req.user.role === 'organizer' && quiz.ownerId === req.user.id)) });
});

app.get('/api/quizzes/:id', authRequired, (req, res) => {
  const db = readDb();
  const quiz = db.quizzes.find((item) => item.id === req.params.id);
  if (!quiz) return res.status(404).json({ message: 'Квиз не найден.' });

  const includeCorrect = req.user.role === 'organizer' && quiz.ownerId === req.user.id;
  res.json({ quiz: safeQuiz(quiz, includeCorrect) });
});

app.post('/api/quizzes', authRequired, organizerRequired, (req, res) => {
  const errors = validateQuizInput(req.body);
  if (errors.length) return res.status(400).json({ message: errors.join(' ') });

  const quiz = makeQuizFromBody(req.body, req.user.id);
  updateDb((db) => {
    db.quizzes.push(quiz);
  });

  res.status(201).json({ quiz: safeQuiz(quiz, true) });
});

app.delete('/api/quizzes/:id', authRequired, organizerRequired, (req, res) => {
  const result = updateDb((db) => {
    const quiz = db.quizzes.find((item) => item.id === req.params.id);
    if (!quiz) return { error: 'Квиз не найден.' };
    if (quiz.ownerId !== req.user.id) return { error: 'Можно удалить только свой квиз.' };
    db.quizzes = db.quizzes.filter((item) => item.id !== req.params.id);
    return { ok: true };
  });

  if (result.error) return res.status(404).json({ message: result.error });
  res.json(result);
});

app.post('/api/rooms', authRequired, organizerRequired, (req, res) => {
  const db = readDb();
  const quiz = db.quizzes.find((item) => item.id === req.body.quizId && item.ownerId === req.user.id);
  if (!quiz) return res.status(404).json({ message: 'Квиз не найден или не принадлежит вам.' });

  let code = roomCode();
  while (rooms.has(code)) code = roomCode();

  const room = {
    code,
    quiz,
    organizerId: req.user.id,
    status: 'lobby',
    currentIndex: -1,
    deadline: null,
    participants: new Map(),
    answers: new Map(),
    closedQuestionIds: new Set(),
    timer: null,
    resultSaved: false,
    startedAt: null
  };

  rooms.set(code, room);
  res.status(201).json({ room: publicRoom(room) });
});

app.get('/api/rooms/:code', authRequired, (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ message: 'Комната не найдена.' });
  res.json({ room: publicRoom(room), currentQuestion: room.status === 'running' ? currentQuestionPayload(room) : null });
});

app.get('/api/history', authRequired, (req, res) => {
  const db = readDb();
  const organized = db.results.filter((result) => result.organizerId === req.user.id);
  const participated = db.results.filter((result) => result.leaderboard.some((item) => item.userId === req.user.id));
  res.json({ organized, participated });
});

io.on('connection', (socket) => {
  socket.on('joinRoom', (payload, ack) => {
    const token = payload?.token;
    const user = getUserByToken(token);
    const code = String(payload?.roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!user) return reply(ack, { ok: false, message: 'Нужна авторизация.' });
    if (!room) return reply(ack, { ok: false, message: 'Комната не найдена.' });

    socket.join(code);
    socket.data.userId = user.id;
    socket.data.roomCode = code;

    if (user.role === 'participant') {
      if (!room.participants.has(user.id)) {
        room.participants.set(user.id, {
          userId: user.id,
          name: user.name,
          score: 0,
          answersCorrect: 0,
          totalAnswered: 0
        });
      }
    }

    io.to(code).emit('roomState', publicRoom(room));
    reply(ack, {
      ok: true,
      room: publicRoom(room),
      currentQuestion: room.status === 'running' ? currentQuestionPayload(room) : null
    });
  });

  socket.on('startQuiz', (payload, ack) => {
    const user = getUserByToken(payload?.token);
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!user || !room) return reply(ack, { ok: false, message: 'Комната не найдена или нет авторизации.' });
    if (room.organizerId !== user.id) return reply(ack, { ok: false, message: 'Запустить квиз может только его организатор.' });
    if (!['lobby', 'question_closed'].includes(room.status)) return reply(ack, { ok: false, message: 'Квиз уже запущен или завершён.' });

    if (!room.startedAt) room.startedAt = nowIso();
    openQuestion(room, room.currentIndex + 1);
    reply(ack, { ok: true });
  });

  socket.on('nextQuestion', (payload, ack) => {
    const user = getUserByToken(payload?.token);
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!user || !room) return reply(ack, { ok: false, message: 'Комната не найдена или нет авторизации.' });
    if (room.organizerId !== user.id) return reply(ack, { ok: false, message: 'Переключать вопросы может только организатор.' });

    if (room.status === 'running') closeCurrentQuestion(room);
    openQuestion(room, room.currentIndex + 1);
    reply(ack, { ok: true });
  });

  socket.on('closeQuestion', (payload, ack) => {
    const user = getUserByToken(payload?.token);
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!user || !room) return reply(ack, { ok: false, message: 'Комната не найдена или нет авторизации.' });
    if (room.organizerId !== user.id) return reply(ack, { ok: false, message: 'Закрыть вопрос может только организатор.' });

    const result = closeCurrentQuestion(room);
    reply(ack, { ok: true, result });
  });

  socket.on('finishQuiz', (payload, ack) => {
    const user = getUserByToken(payload?.token);
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!user || !room) return reply(ack, { ok: false, message: 'Комната не найдена или нет авторизации.' });
    if (room.organizerId !== user.id) return reply(ack, { ok: false, message: 'Завершить квиз может только организатор.' });

    finishRoom(room);
    reply(ack, { ok: true });
  });

  socket.on('submitAnswer', (payload, ack) => {
    const user = getUserByToken(payload?.token);
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());

    if (!user || !room) return reply(ack, { ok: false, message: 'Комната не найдена или нет авторизации.' });
    if (user.role !== 'participant') return reply(ack, { ok: false, message: 'Отвечать может только участник.' });
    if (room.status !== 'running') return reply(ack, { ok: false, message: 'Сейчас нет открытого вопроса.' });
    if (Date.now() > room.deadline) return reply(ack, { ok: false, message: 'Время ответа истекло.' });

    const question = room.quiz.questions[room.currentIndex];
    if (!question || question.id !== payload?.questionId) {
      return reply(ack, { ok: false, message: 'Вопрос уже изменился.' });
    }

    const availableIds = new Set(question.options.map((option) => option.id));
    const optionIds = Array.isArray(payload.optionIds)
      ? payload.optionIds.filter((optionId) => availableIds.has(optionId))
      : [];

    if (!question.allowMultiple && optionIds.length > 1) {
      return reply(ack, { ok: false, message: 'Для этого вопроса можно выбрать только один вариант.' });
    }
    if (optionIds.length === 0) {
      return reply(ack, { ok: false, message: 'Выберите хотя бы один вариант.' });
    }

    if (!room.answers.has(question.id)) room.answers.set(question.id, new Map());
    const questionAnswers = room.answers.get(question.id);

    if (questionAnswers.has(user.id)) {
      return reply(ack, { ok: false, message: 'Ответ на этот вопрос уже отправлен.' });
    }

    questionAnswers.set(user.id, { optionIds, submittedAt: Date.now() });
    reply(ack, { ok: true, message: 'Ответ принят.' });
    io.to(room.code).emit('roomState', publicRoom(room));
  });
});

seedDemoData();

server.listen(PORT, () => {
  console.log(`Quiz Realtime API is running on http://localhost:${PORT}`);
});
