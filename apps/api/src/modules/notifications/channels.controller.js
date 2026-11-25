'use strict';

const service = require('./channels.service');
const { parsePagination } = require('../../utils/pagination');

async function list(req, res) {
  const pagination = parsePagination(req.query);
  const result = await service.list(req.membership.organizationId, pagination);
  res.status(200).json(result);
}

async function get(req, res) {
  const channel = await service.getById(
    req.membership.organizationId,
    Number(req.params.channelId)
  );
  res.status(200).json({ channel });
}

async function create(req, res) {
  const channel = await service.create(req.membership.organizationId, req.body);
  res.status(201).json({ channel });
}

async function update(req, res) {
  const channel = await service.update(
    req.membership.organizationId,
    Number(req.params.channelId),
    req.body
  );
  res.status(200).json({ channel });
}

async function remove(req, res) {
  await service.remove(req.membership.organizationId, Number(req.params.channelId));
  res.status(204).send();
}

module.exports = { list, get, create, update, remove };
