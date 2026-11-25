'use strict';

const service = require('./metrics.service');
const { parsePagination } = require('../../utils/pagination');
const { historyQuerySchema, summaryQuerySchema } = require('./metrics.validation');

async function history(req, res) {
  const pagination = parsePagination(req.query);
  const filters = historyQuerySchema.parse(req.query);
  const result = await service.getHistory(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId,
    pagination,
    filters
  );
  res.status(200).json(result);
}

async function summary(req, res) {
  const { window } = summaryQuerySchema.parse(req.query);
  const result = await service.getSummary(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId,
    window
  );
  res.status(200).json(result);
}

module.exports = { history, summary };
