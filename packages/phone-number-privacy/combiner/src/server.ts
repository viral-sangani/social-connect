import { ContractKit } from '@celo/contractkit'
import {
  CombinerEndpoint,
  ErrorMessage,
  getContractKitWithAgent,
  KEY_VERSION_HEADER,
  loggerMiddleware,
  newContractKitFetcher,
  OdisRequest,
  rootLogger,
} from '@celo/phone-number-privacy-common'
import express, { Express, RequestHandler } from 'express'
import httpProxy from 'http-proxy'
import { Signer } from './common/combine'
import {
  catchErrorHandler,
  disabledHandler,
  Locals,
  meteringHandler,
  resultHandler,
  ResultHandler,
  tracingHandler,
} from './common/handlers'
import { CombinerConfig, getCombinerVersion } from './config'
import { disableDomain } from './domain/endpoints/disable/action'
import { domainQuota } from './domain/endpoints/quota/action'
import { domainSign } from './domain/endpoints/sign/action'
import { pnpQuota } from './pnp/endpoints/quota/action'
import { pnpSign } from './pnp/endpoints/sign/action'
const streamify = require('stream-array')

require('events').EventEmitter.defaultMaxListeners = 15

export function startCombiner(config: CombinerConfig, kit?: ContractKit): Express {
  const logger = rootLogger(config.serviceName)

  kit = kit ?? getContractKitWithAgent(config.blockchain)

  logger.info('Creating combiner express server')
  const app = express()

  // TODO get logger to show accurate serviceName
  // (https://github.com/celo-org/celo-monorepo/issues/9809)
  app.use(express.json({ limit: '0.2mb' }) as RequestHandler, loggerMiddleware(config.serviceName))

  // Enable cross origin resource sharing from any domain so ODIS can be interacted with from web apps
  //
  // Security note: Allowing unrestricted cross-origin requests is acceptable here because any authenticated actions
  // must include a signature in the request body. In particular, ODIS _does not_ use cookies to transmit authentication
  // data. If ODIS is altered to use cookies for authentication data, this CORS policy should be reconsidered.
  app.use((_, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header(
      'Access-Control-Allow-Headers',
      `Origin, X-Requested-With, Content-Type, Accept, Authorization, ${KEY_VERSION_HEADER}`
    )
    next()
  })

  app.get(CombinerEndpoint.STATUS, (_req, res) => {
    res.status(200).json({
      version: getCombinerVersion(),
    })
  })

  const dekFetcher = newContractKitFetcher(
    kit,
    logger,
    config.phoneNumberPrivacy.fullNodeTimeoutMs,
    config.phoneNumberPrivacy.fullNodeRetryCount,
    config.phoneNumberPrivacy.fullNodeRetryDelayMs
  )

  const pnpSigners: Signer[] = JSON.parse(config.phoneNumberPrivacy.odisServices.signers)
  const domainSigners: Signer[] = JSON.parse(config.domains.odisServices.signers)

  const { domains, phoneNumberPrivacy } = config

  app.post(
    CombinerEndpoint.PNP_QUOTA,
    createHandler(phoneNumberPrivacy.enabled, pnpQuota(pnpSigners, phoneNumberPrivacy, dekFetcher))
  )
  app.post(
    CombinerEndpoint.PNP_SIGN,
    createHandler(phoneNumberPrivacy.enabled, pnpSign(pnpSigners, phoneNumberPrivacy, dekFetcher))
  )
  app.post(
    CombinerEndpoint.DOMAIN_QUOTA_STATUS,
    createHandler(domains.enabled, domainQuota(domainSigners, domains))
  )
  app.post(
    CombinerEndpoint.DOMAIN_SIGN,
    createHandler(domains.enabled, domainSign(domainSigners, domains))
  )
  app.post(
    CombinerEndpoint.DISABLE_DOMAIN,
    createHandler(domains.enabled, disableDomain(domainSigners, domains))
  )

  return app
}

function createHandler<R extends OdisRequest>(
  enabled: boolean,
  action: ResultHandler<R>
): RequestHandler<{}, {}, R, {}, Locals> {
  return catchErrorHandler(
    tracingHandler(meteringHandler(enabled ? resultHandler(action) : disabledHandler))
  )
}

export function startProxy(req: any, res: any, config: CombinerConfig) {
  const logger = rootLogger(config.serviceName)

  logger.info({ request: req }, 'Starting proxy.')

  let destinationUrl: string
  let rawBodyString: string
  let rawBodyJson: any
  let rawBodyData: any[] = []

  const proxy = httpProxy.createProxyServer({
    proxyTimeout: config.phoneNumberPrivacy.odisServices.timeoutMilliSeconds,
  })

  if (req.rawBody) {
    // XXX having to strigify and then parse, because simply using `req.rawBody.data` does not work.
    rawBodyString = JSON.stringify(req.rawBody)
    rawBodyJson = JSON.parse(rawBodyString)
    rawBodyData = rawBodyJson.data
  }

  switch (config.proxy.deploymentEnv) {
    case 'mainnet':
      destinationUrl = 'https://us-central1-celo-pgpnp-mainnet.cloudfunctions.net/combinerGen2'
      break

    case 'alfajores':
      destinationUrl =
        'https://us-central1-celo-phone-number-privacy.cloudfunctions.net/combinerGen2'
      break

    case 'staging':
      destinationUrl =
        'https://us-central1-celo-phone-number-privacy-stg.cloudfunctions.net/combinerGen2'
      break

    default:
      throw ErrorMessage.UNKNOWN_ERROR
  }

  logger.info(
    {
      request: req,
      rawBodyData: rawBodyData,
      destinationURL: destinationUrl,
    },
    'Proxying request to staging Combiner gen 2.'
  )

  proxy.web(req, res, {
    target: destinationUrl,
    buffer: streamify(rawBodyData.length != 0 ? [Buffer.from(rawBodyData)] : []),
    changeOrigin: true,
  })

  proxy.on('error', (err) => {
    logger.error({ err }, 'Error in Proxying request to Combiner.')
    res.status(500).json({
      success: false,
      error: err,
    })
  })
}
