'use strict';

const authService = require('./auth.service');

/**
 * POST /auth/register
 */
async function register(req, res) {
  const result = await authService.register(req.body);
  res.status(201).json(result);
}

/**
 * POST /auth/login
 */
async function login(req, res) {
  const result = await authService.login(req.body);
  res.status(200).json(result);
}

/**
 * POST /auth/refresh
 */
async function refresh(req, res) {
  const result = await authService.refresh(req.body);
  res.status(200).json(result);
}

/**
 * POST /auth/logout
 */
async function logout(req, res) {
  await authService.logout(req.body);
  res.status(204).send();
}

module.exports = { register, login, refresh, logout };
