const axios = require('axios');
const qs = require('querystring');

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

module.exports = {
  getToken,
};
