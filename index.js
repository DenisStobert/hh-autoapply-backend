require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const qs = require('querystring');
const hh = require('./services/hh'); // Подключаем файл hh.js

const app = express();
app.use(cors());
app.use(bodyParser.json());

let accessToken = null; // Сохраняем токен в памяти (временно)
let storedRefreshToken = null; // Сохраняем refresh токен

// Эндпоинт для авторизации
app.get('/auth', (req, res) => {
  const state = 'random_state'; // Это может быть любая случайная строка для безопасности
  const url = `https://hh.ru/oauth/authorize?response_type=code&client_id=${process.env.HH_CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}&state=${state}`;
  res.redirect(url);  // Перенаправление пользователя на страницу авторизации HH
});

// Эндпоинт для обработки callback и получения кода
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const tokens = await hh.getToken(code);
    console.log('✅ Получен токен:', tokens);

    accessToken = tokens.access_token;
    storedRefreshToken = tokens.refresh_token;

    const deepLink = `exp://10.0.0.56:8081/--/auth-success?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}`;
    console.log('📡 Отправляем редирект в приложение:', deepLink);

    // Вместо обычного redirect — покажем HTML-страницу с кнопкой
    res.send(`
      <html>
        <head>
          <title>Возврат в приложение</title>
        </head>
        <body>
          <h2>Почти готово!</h2>
          <p>Нажмите кнопку ниже, чтобы вернуться в приложение AutoApply.</p>
          <a href="${deepLink}">
            <button style="padding: 10px 20px; font-size: 16px;">Открыть AutoApply</button>
          </a>
          <script>
            // Автоматически попытаемся открыть приложение
            window.location = "${deepLink}";
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('❌ Ошибка получения токена:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to get token' });
  }
});
app.get('/me', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'No token available' });
  }

  try {
    const response = await axios.get('https://api.hh.ru/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    res.json(response.data);
  } catch (e) {
    console.error('Ошибка при проверке токена /me:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: 'Token invalid or expired' });
  }
});

app.get('/dialogs', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await axios.get('https://api.hh.ru/negotiations', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const dialogs = response.data.items || [];

    // Загружаем employer для каждой вакансии
    const enrichedDialogs = await Promise.all(dialogs.map(async (dialog) => {
      try {
        const vacancyId = dialog.vacancy?.id;
        if (!vacancyId) return dialog;
    
        const vacancyRes = await axios.get(`https://api.hh.ru/vacancies/${vacancyId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
    
        const employer = vacancyRes.data.employer;
    
        // Новый запрос к /employers/{id}
        const employerDetails = await axios.get(`https://api.hh.ru/employers/${employer.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
    
        return {
          ...dialog,
          employer: {
            ...employer,
            last_online: employerDetails.data.last_online_at,
            response_rate: employerDetails.data.response_rate,
          },
        };
      } catch (e) {
        console.warn(`⚠️ Ошибка для вакансии ${dialog.vacancy?.id}`, e.message);
        return dialog;
      }
    }));
    
    res.json({ items: enrichedDialogs });
  } catch (e) {
    console.error('Ошибка при получении диалогов:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch dialogs' });
  }
});


// Получение сообщений из конкретного диалога
app.get('/dialogs/:id/messages', async (req, res) => {
  const dialogId = req.params.id;
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await axios.get(`https://api.hh.ru/negotiations/${dialogId}/messages`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    console.log(`📩 Сообщения по диалогу ${dialogId}:`, response.data);
    res.json(response.data);
  } catch (e) {
    console.error(`Ошибка при получении сообщений для диалога ${dialogId}:`, e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/resumes', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await axios.get('https://api.hh.ru/resumes/mine', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    res.json(response.data);
  } catch (e) {
    console.error('Ошибка при получении резюме:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch resumes' });
  }
});

// Эндпоинт для получения вакансий с использованием токена
app.get('/vacancies', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }

  console.log('Используем accessToken:', accessToken);

  const {
    text = '',
    category = '',
    salary_from = '',
    salary_to = '',
    only_with_salary,
    experience,
    page = 0,
    per_page = 20,
  } = req.query;
  
  const params = {
    text,
    specialization: category,
    salary_from,
    salary_to,
    experience,
    page,
    per_page,
  };
  
  if (only_with_salary === 'true') {
    params.only_with_salary = true;
  }

  try {
    const response = await axios.get('https://api.hh.ru/vacancies', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params,
    });

    res.json(response.data);
  } catch (e) {
    // Если токен истёк (401), пробуем обновить
    if (e.response && e.response.status === 401) {
      console.warn('🔄 Access token истёк. Пробуем обновить...');
      try {
        await refreshToken(); // обновит accessToken и storedRefreshToken
        // Повторный запрос после обновления
        const retry = await axios.get('https://api.hh.ru/vacancies', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params,
        });
        return res.json(retry.data);
      } catch (refreshError) {
        console.error('❌ Не удалось обновить токен:', refreshError.response?.data || refreshError.message);
        return res.status(401).json({ error: 'Токен истёк и не удалось обновить. Войдите снова.' });
      }
    }

    console.error('Ошибка при получении вакансий:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch vacancies' });
  }
});

// В твоём backend-е, в /vacancies/:id/apply
app.post('/vacancies/:id/apply', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;

  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Получаем список резюме
    const resumeRes = await axios.get('https://api.hh.ru/resumes/mine', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const resume =
      Array.isArray(resumeRes.data.items) && resumeRes.data.items.length > 0
        ? resumeRes.data.items[0]
        : Array.isArray(resumeRes.data) && resumeRes.data.length > 0
        ? resumeRes.data[0]
        : null;

    if (!resume || !resume.id) {
      console.error('❌ Резюме не найдено.');
      return res.status(400).json({ error: 'No resume found' });
    }

    // Проверка перед отправкой
    if (!id) {
      console.error('❌ vacancy_id отсутствует');
      return res.status(400).json({ error: 'Missing vacancy_id' });
    }

    console.log(`▶️ Отправляем отклик: vacancy_id=${id}, resume_id=${resume.id}`);

    const applyPayload = {
      vacancy_id: id,
      resume_id: resume.id,
    };

    if (message) {
      applyPayload.message = message;
    }

    const response = await axios.post(
      'https://api.hh.ru/negotiations',
      qs.stringify({
        vacancy_id: id,
        resume_id: resume.id,
        ...(message ? { message } : {})
      }),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    res.status(response.status).json({
      success: true,
      state: response.data.state || { id: 'response' }, // <- важно
    });
  } catch (e) {
    console.error(`❌ Ошибка при отклике на вакансию ${id}:`, e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: 'Failed to apply to vacancy' });
  }
});

// Функция для получения токена через API
async function getToken(code) {
  const params = {
    grant_type: 'authorization_code',
    client_id: process.env.HH_CLIENT_ID,
    client_secret: process.env.HH_CLIENT_SECRET,
    code: code,
    redirect_uri: process.env.REDIRECT_URI,
  };

  try {
    const response = await axios.post('https://api.hh.ru/token', qs.stringify(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка при получении токена:', error.response?.data || error.message);
    throw error;
  }
}

// Функция для обновления токена через refresh_token
async function refreshToken() {
  const params = {
    grant_type: 'refresh_token',
    client_id: process.env.HH_CLIENT_ID,
    client_secret: process.env.HH_CLIENT_SECRET,
    refresh_token: storedRefreshToken,  // Используем переименованную переменную
  };

  try {
    const response = await axios.post('https://api.hh.ru/token', qs.stringify(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    console.log('Токен обновлен:', response.data);
    accessToken = response.data.access_token;  // Обновляем access_token
    storedRefreshToken = response.data.refresh_token;  // Обновляем refresh_token
    return response.data;
  } catch (error) {
    console.error('Ошибка при обновлении токена:', error.response?.data || error.message);
    throw error;
  }
}

app.listen(process.env.PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
