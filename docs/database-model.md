# Модель данных

В MVP данные хранятся в JSON-файле `server/data/db.json`. Логическая модель спроектирована так, чтобы её можно было перенести в SQL-БД.

## Сущности

### users

| Поле | Тип | Описание |
|---|---|---|
| id | string | Уникальный идентификатор пользователя |
| name | string | Имя пользователя |
| email | string | Email для входа |
| role | string | `organizer` или `participant` |
| salt | string | Соль для хеширования пароля |
| passwordHash | string | Хеш пароля |
| createdAt | string | Дата регистрации |

### tokens

| Поле | Тип | Описание |
|---|---|---|
| token | string | Токен сессии |
| userId | string | ID пользователя |
| createdAt | string | Дата создания токена |

### quizzes

| Поле | Тип | Описание |
|---|---|---|
| id | string | ID квиза |
| ownerId | string | ID организатора |
| title | string | Название квиза |
| category | string | Категория |
| rules | string | Правила |
| questionTimeSeconds | number | Время ответа по умолчанию |
| createdAt | string | Дата создания |
| questions | array | Список вопросов |

### questions

| Поле | Тип | Описание |
|---|---|---|
| id | string | ID вопроса |
| type | string | `text` или `image` |
| text | string | Текст вопроса |
| imageUrl | string | URL изображения, если вопрос с картинкой |
| allowMultiple | boolean | Разрешён ли множественный выбор |
| timeLimitSeconds | number | Время на конкретный вопрос |
| position | number | Порядок вопроса |
| options | array | Варианты ответа |

### options

| Поле | Тип | Описание |
|---|---|---|
| id | string | ID варианта ответа |
| text | string | Текст варианта |
| correct | boolean | Правильный ли вариант |

### results

| Поле | Тип | Описание |
|---|---|---|
| id | string | ID результата |
| quizId | string | ID квиза |
| quizTitle | string | Название квиза на момент прохождения |
| roomCode | string | Код комнаты |
| organizerId | string | ID организатора |
| startedAt | string | Дата начала |
| endedAt | string | Дата окончания |
| leaderboard | array | Итоговая таблица участников |

## Возможная SQL-схема

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'participant')),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE quizzes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  rules TEXT NOT NULL,
  question_time_seconds INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('text', 'image')),
  text TEXT NOT NULL,
  image_url TEXT,
  allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
  time_limit_seconds INTEGER NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id),
  room_code TEXT NOT NULL,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NOT NULL
);

CREATE TABLE result_rows (
  id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL,
  answers_correct INTEGER NOT NULL,
  total_answered INTEGER NOT NULL
);
```
