'use strict'

module.exports = {
  ...require('./businesses'),
  ...require('./customers'),
  ...require('./appointments'),
  ...require('./processedMessages'),
  ...require('./oauthStates'),
  ...require('./pendingPayments'),
  ...require('./knowledgeChunks'),
  ...require('./invoices')
}
