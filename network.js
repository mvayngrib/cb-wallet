"use strict";

var bitcoin = require('bitcoinjs-lib')
var discover = require('bip32-utils').discovery
var async = require('async')

function discoverAddressesForAccounts(api, externalAccount, internalAccount, gapLimit, callback) {
  var functions = [externalAccount, internalAccount].map(function(account) {
    return function(cb) { discoverUsedAddresses(account, api, gapLimit, cb) }
  })

  async.parallel(functions, function(err, results) {
    if(err) return callback(err);

    callback(null, results[0], results[1])
  })
}

function discoverUsedAddresses(account, api, gapLimit, done) {
  gapLimit = typeof gapLimit === 'undefined' ? 10 : gapLimit
  // offset = typeof offset === 'undefined' ? 0 : offset

  var usedAddresses = []

  discover(account, gapLimit, function(addresses, callback) {

    usedAddresses.push.apply(usedAddresses, addresses)

    api.addresses.summary(addresses, function(err, results) {
      if (err) return callback(err);

      callback(undefined, results.map(function(result, i) {
        return result.txCount > 0
      }))
    })
  }, function(err, k) {
    if (err) return done(err);

    console.info('Discovered ' + k + ' addresses')

    done(null, usedAddresses)
  })
}

function fetchTransactions(api, addresses, blockHeight, done) {
  api.addresses.transactions(addresses, blockHeight, function(err, transactions) {
    if(err) return done(err);

    var parsed = parseTransactions(transactions)

    api.transactions.get(getAdditionalTxIds(parsed.txs), function(err, transactions) {
      if(err) return done(err);

      parsed = parseTransactions(transactions, parsed)
      done(null, parsed.txs, parsed.metadata)
    })
  })
}

function parseTransactions(transactions, initialValue) {
  initialValue = initialValue || {txs: [], metadata: {}}
  return transactions.reduce(function(memo, t) {
    var tx = bitcoin.Transaction.fromHex(t.txHex)
    memo.txs.push(tx)
    memo.metadata[tx.getId()] = {
      confirmations: t.__confirmations,
      timestamp: t.__blockTimestamp
    }

    return memo
  }, initialValue)
}

function getAdditionalTxIds(txs) {
  var inputTxIds = txs.reduce(function(memo, tx) {
    tx.ins.forEach(function(input) {
      var hash = new Buffer(input.hash)
      Array.prototype.reverse.call(hash)
      memo[hash.toString('hex')] = true
    })
    return memo
  }, {})

  var txIds = txs.map(function(tx) { return tx.getId() })

  return Object.keys(inputTxIds).filter(function(id) {
    return txIds.indexOf(id) < 0
  })
}

module.exports = {
  discoverAddresses: discoverAddressesForAccounts,
  fetchTransactions: fetchTransactions
}
