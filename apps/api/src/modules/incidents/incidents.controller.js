'use strict';

const service = require('./incidents.service');
const { parsePagination } = require('../../utils/pagination');
const { listIncidentsQuerySchema } = require('./incidents.validation');

async function list(req, res) {
  const pagination = parsePagination(req.query);
  const filters = listIncidentsQuerySchema.parse(req.query);
  const result = await service.listInOrg(req.membership.organizationId, pagination, filters);
  res.status(200).json(result);
}

async function get(req, res) {
  const incident = await service.getInOrg(req.membership.organizationId, req.params.incidentId);
  res.status(200).json({ incident });
}

module.exports = { list, get };
