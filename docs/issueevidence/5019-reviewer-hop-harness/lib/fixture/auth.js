'use strict';
const { BAD_PASSWORD, WELCOME } = require('./messages');

// users: { name: { password } }
function login(users, name, password) {
  const u = users[name];
  if (u && u.password === password) return WELCOME;
  return BAD_PASSWORD;
}
module.exports = { login };
