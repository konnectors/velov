const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  utils
} = require('cozy-konnector-libs')

const request = requestFactory({
  debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const requestJSON = requestFactory({
  cheerio: false,
  json: true,
  debug: true,
  jar: true
})

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await this.deactivateAutoSuccessfulLogin()
  const loginInfos = await authenticate.bind(this)(
    fields.login,
    fields.password
  )
  await this.notifySuccessfulLogin()
  log('info', 'Successfully logged in')

  const bills = await getBills(loginInfos, fields)
  console.log(bills)


  //await saveBills(bills, fields, {
  await saveBills([bills[2]], fields, {
    contentType: 'application/pdf',
    fileIdAttributes: ['vendorRef']
  })
}

async function authenticate(username, password) {
  // Requesting a Oauth token for GrandLyon offer
  const clientTokenReq = await requestJSON({
    uri: 'https://api.cyclocity.fr/auth/environments/PRD/client_tokens',
    method: 'POST',
    json: {
      code: 'vls.web.lyon:PRD',
      key: 'c3d9f5c22a9157a7cc7fe0e38269573bdd2f13ec48f867360ecdcbd35b196f87'
    }
  })
  const authorizationToken = `Taknv1 ${clientTokenReq.accessToken}`

  // Login in grandLyon api, will follow the redirect uri
  const loginReq = await requestJSON({
    uri: 'https://api.cyclocity.fr/identities/users/login',
    method: 'GET',
    qs: {
      takn: clientTokenReq.accessToken,
      email: username,
      password: password,
      redirect_uri: 'https://velov.grandlyon.com/openid_connect_login'
    },
    resolveWithFullResponse: true
  })
  // We need to extract this code to validate the login on ciclocity too
  const OauthCode = loginReq.request.uri.query.split('=')[1]

  // Login to cyclocity API
  const loginReq2 = await requestJSON({
    uri: 'https://api.cyclocity.fr/identities/token',
    method: 'POST',
    qs: {
      grant_type: 'authorization_code',
      code: OauthCode,
      redirect_uri: 'https://velov.grandlyon.com/openid_connect_login' // Mandatory
    },
    headers: {
      Authorization: authorizationToken
    }
  })
  const identityToken = loginReq2.id_token

  // Requesting the id associated to mail needed later
  const accountId = await requestJSON({
    uri: 'https://api.cyclocity.fr/contracts/lyon/accounts/fabien.bassereau@gmail.com/id',
    method: 'GET',
    headers: {
      Identity: identityToken
    }
  })

/*
  const transactionsUri = `https://api.cyclocity.fr/contracts/lyon/accounts/${accountId}/transactions`
  const transactions = await requestJSON({
    uri: transactionsUri,
    headers: {
      Authorization: `Taknv1 ${clientTokenReq.accessToken}`,
      Identity: identityToken,
      accept: 'application/vnd.transaction.v1+json',
      //'Content-Type': 'application/vnd.transaction.v1+json'

    }
  })
  console.log(transactions)
  */

  return { identityToken, authorizationToken, accountId }
}

async function getBills(loginInfos) {
  const transactionsUri = `https://api.cyclocity.fr/contracts/lyon/accounts/${loginInfos.accountId}/transactions`
  const transactions = await requestJSON({
    uri: transactionsUri,
    headers: {
      Authorization: loginInfos.authorizationToken,
      Identity: loginInfos.identityToken,
      accept: 'application/vnd.transaction.v1+json' // Mandatory, else 406
    }
  })

  console.log(transactions)
  const bills = []
  for (const transaction of transactions) {
    const amount = transaction.amount / 100 // Raw amount in cents of euros
    const date = new Date(transaction.createdAt)
    const bill = {
      amount,
      currency: 'EUR',
      date,
      fileurl: `https://api.cyclocity.fr/contracts/lyon/accounts/${loginInfos.accountId}/transactions/${transaction.id}/bill`,
      filename: `${utils.formatDate(date)}_Vélo'v_${amount.toFixed(2)}EUR_${
        transaction.paymentRef
      }.pdf`,
      vendorRef: transaction.paymentRef,
      requestOptions: {
        headers: {
          Authorization: loginInfos.authorizationToken,
          Identity: loginInfos.identityToken,
          accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/vnd.transaction.v1+json',
          //'Accept-Language': 'fr'
        }
      }
    }
    bills.push(bill)
  }
  return bills
}
