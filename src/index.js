process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://5e2fbcf13598a6df1e6bd8379da7825b@errors.cozycloud.cc/74'

const {
  BaseKonnector,
  cozyClient,
  requestFactory,
  log,
  errors,
  utils
} = require('cozy-konnector-libs')

const requestJSON = requestFactory({
  cheerio: false,
  json: true,
  debug: false,
  jar: true,
  headers: {
    'Accept-Language': 'fr' // Mandatory to have pdf in French
  }
})

const VENDOR = 'velov'
const BASE_URL = 'https://api.cyclocity.fr'
// Importing models to get qualification by label
const models = cozyClient.new.models
const { Qualification } = models.document

module.exports = new BaseKonnector(start)

async function start(fields) {
  // First fetching offer client key
  const homeReq = await requestJSON('https://velov.grandlyon.com/fr/home')
  const nameMainJs = homeReq.match(/src="(main\.(.*)\.js)"/)[1]
  log('debug', `Main js file detected : ${nameMainJs}`)
  const mainJsReq = await requestJSON(
    `https://velov.grandlyon.com/${nameMainJs}`
  )
  const offerClientKey = mainJsReq.match(/clientKey:"(.*?)"/)[1]
  log('debug', `Offer client key detected : ${offerClientKey}`)

  log('info', 'Authenticating ...')
  await this.deactivateAutoSuccessfulLogin()
  const loginInfos = await authenticate.bind(this)(
    fields.login,
    fields.password,
    offerClientKey
  )
  await this.notifySuccessfulLogin()
  log('info', 'Successfully logged in')

  const bills = await getBills(loginInfos, fields)

  await this.saveBills(bills, fields, {
    contentType: 'application/pdf',
    fileIdAttributes: ['vendorRef'],
    identifiers: [VENDOR],
    validateFile,
    retry: 2
  })
}

function validateFile(doc) {
  const size = doc.size
  if (size < 900) {
    log('warn', 'BAD_FILE_SIZE')
    return false
  }
  return true
}

async function authenticate(username, password, offerClientKey) {
  // Requesting a Oauth token for GrandLyon offer
  const clientTokenReq = await requestJSON({
    uri: `${BASE_URL}/auth/environments/PRD/client_tokens`,
    method: 'POST',
    json: {
      code: 'vls.web.lyon:PRD',
      key: offerClientKey
    }
  })
  const authorizationToken = `Taknv1 ${clientTokenReq.accessToken}`

  // Login in grandLyon api, will follow the redirect uri
  const loginReq = await requestJSON({
    uri: `${BASE_URL}/identities/users/login`,
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
  let loginReq2
  try {
    loginReq2 = await requestJSON({
      uri: `${BASE_URL}/identities/token`,
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
  } catch (e) {
    if (e.statusCode === 400) {
      log('error', e)
      throw new Error(errors.LOGIN_FAILED)
    } else {
      throw e
    }
  }
  const identityToken = loginReq2.id_token

  // Requesting the id associated to mail needed later
  const accountId = await requestJSON({
    uri: `${BASE_URL}/contracts/lyon/accounts/${username}/id`,
    method: 'GET',
    headers: {
      Identity: identityToken
    }
  })

  return { identityToken, authorizationToken, accountId }
}

async function getBills(loginInfos) {
  const transactionsUri = `${BASE_URL}/contracts/lyon/accounts/${loginInfos.accountId}/transactions`
  const transactions = await requestJSON({
    uri: transactionsUri,
    headers: {
      Authorization: loginInfos.authorizationToken,
      Identity: loginInfos.identityToken,
      accept: 'application/vnd.transaction.v1+json' // Mandatory, else 406
    }
  })

  const bills = []
  for (const transaction of transactions) {
    const amount = transaction.amount / 100 // Raw amount in cents of euros
    const date = new Date(transaction.createdAt)
    const bill = {
      vendor: VENDOR,
      amount,
      currency: 'EUR',
      date,
      fileurl: `${BASE_URL}/contracts/lyon/accounts/${loginInfos.accountId}/transactions/${transaction.id}/bill`,
      filename: `${utils.formatDate(date)}_Vélo'v_${amount.toFixed(
        2
      )}EUR_${transaction.paymentRef.slice(-4)}.pdf`,
      vendorRef: transaction.paymentRef,
      fileAttributes: {
        metadata: {
          issueDate: date,
          datetime: date,
          datetimeLabel: `issueDate`,
          carbonCopy: true,
          qualification: Qualification.getByLabel('transport_invoice')
        }
      },
      requestOptions: {
        headers: {
          Authorization: loginInfos.authorizationToken,
          Identity: loginInfos.identityToken,
          accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/vnd.transaction.v1+json',
          'Accept-Language': 'fr' // Mandatory to have pdf in French
        }
      }
    }
    bills.push(bill)
  }
  return bills
}
