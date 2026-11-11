'use strict'

// The timeline in AWS (DynamoDB). Local runs keep it in memory, so this is the
// only check of the real queries: 'scope' is a DynamoDB reserved word and must
// go through a placeholder, or every Under the hood read fails.

const sent = []
jest.mock('../services/dynamo/client', () => {
  class Cmd { constructor(input) { this.input = input } }
  return {
    db: { send: async cmd => { sent.push(cmd.input); return { Items: [] } } },
    TABLES: { TRACE_EVENTS: 'flowhq-trace-events' },
    QueryCommand: Cmd, DeleteCommand: Cmd, PutCommand: Cmd
  }
})

const trace = require('../services/trace')

beforeEach(() => { sent.length = 0; trace.setSink(null) })

test('reading and clearing the timeline name the scope key through a placeholder', async () => {
  await trace.read('sess:abc', null, 50)
  await trace.read('sess:abc', '0001', 50)
  await trace.clear('sess:abc')
  expect(sent).toHaveLength(3)
  for (const q of sent) {
    expect(q.KeyConditionExpression).not.toMatch(/(^|[^#])scope/)
    expect(q.ExpressionAttributeNames).toEqual({ '#scope': 'scope' })
  }
})
