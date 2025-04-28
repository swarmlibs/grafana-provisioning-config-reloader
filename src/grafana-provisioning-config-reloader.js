import fs from 'node:fs'
import os from 'node:os'
import pino from 'pino'
import chokidar from 'chokidar'
import debounce from 'debounce'
import picomatch from 'picomatch'
import pRetry, { AbortError } from 'p-retry';
import { v4 as uuidv4 } from 'uuid'
import pinoPretty from 'pino-pretty'

// Grafana environment variables
const GF_SERVER_DOMAIN = process.env['GF_SERVER_DOMAIN'] || 'localhost'
const GF_SERVER_PROTOCOL = process.env['GF_SERVER_PROTOCOL'] || 'http'
const GF_SERVER_HTTP_PORT = process.env['GF_SERVER_HTTP_PORT'] || '3000'
const GF_SERVER_ROOT_URL=`${GF_SERVER_PROTOCOL}://${GF_SERVER_DOMAIN}:${GF_SERVER_HTTP_PORT}`
const GF_SECURITY_ADMIN_USER = process.env['GF_SECURITY_ADMIN_USER'] || 'grafana'
const GF_SECURITY_ADMIN_PASSWORD = process.env['GF_SECURITY_ADMIN_PASSWORD'] || 'grafana'
const GF_PATHS_PROVISIONING = process.env['GF_PATHS_PROVISIONING'] || '/etc/grafana/provisioning'

// gf-provisioning-config-reloader
/**
 * Possible values: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"
 */
const GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL'] || 'info'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_DATA_DIR = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_DATA_DIR'] || '/data'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_SERVICE_ACCOUNT_FILE = `${GRAFANA_PROVISIONING_CONFIG_RELOADER_DATA_DIR}/serviceaccount.json`

const GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED'] || 'true'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED'] || 'true'
const GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED = process.env['GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED'] || 'true'

const defaultServiceAccountObject = () => {
    const [id, password] = [uuidv4(), uuidv4()]
    return {
        "email": `${id}@gf-provisioning-config-reloader`,
        "login": `gf-provisioning-config-reloader-${id}`,
        "password": password,
    }
}

/**
 * Send a request to the Grafana API
 * @param {string} path
 * @param {RequestInit} opts
 * @returns 
 */
function request(path, opts = {}) {
    const headers = new Headers(opts.headers)
    delete opts.headers
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
    }
    if (!headers.has('Authorization')) {
        headers.set('Authorization', `Basic ${generateBasicAuthToken(GF_SECURITY_ADMIN_USER, GF_SECURITY_ADMIN_PASSWORD)}`)
    }
    return fetch(`${GF_SERVER_ROOT_URL}/api/${path}`, { headers, ...opts })
}

function generateBasicAuthToken(username, password) {
    return btoa(`${username}:${password}`)
}

/**
 * Send a POST request to the Grafana API
 * @param {string} path 
 * @param {Record<any, any>} data 
 * @param {RequestInit} opts
 * @returns 
 */
function write(path, data, opts = {}) {
    return request(path, {
        method: 'POST',
        body: JSON.stringify(data),
        ...opts,
    }).then(async res => {
        const json = await res.json()
        if (res.status !== 200) {
            throw new Error(`(${res.statusText}) ${json.message}`)
        }
        return json
    })
}

/**
 * Send a PUT request to the Grafana API
 * @param {string} path 
 * @param {Record<any, any>} data 
 * * @param {RequestInit} opts
 * @returns 
 */
function update(path, data, opts = {}) {
    return request(path, {
        method: 'PUT',
        body: JSON.stringify(data),
        ...opts,
    }).then(async res => {
        const json = await res.json()
        if (res.status !== 200) {
            throw new Error(`(${res.statusText}) ${json.message}`)
        }
        return json
    })
}

function sleep(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms * 1000))
}

// Wait for Grafana to be ready
function waitforgrafana() {
    logger.info('Waiting for Grafana to be ready...')
    return pRetry(async () => {
        const response = await fetch(`${GF_SERVER_ROOT_URL}/api/health`)
        const json = await response.json()
        if (json.database !== "ok") {
            throw new AbortError(`Grafana health check failed with database status: ${json.database}`)
        }
        if (response.status !== 200) { await sleep(5) }
    }, {
        retries: 5,
        onFailedAttempt: error => {
            logger.info(`Grafana health check attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`);
        },
    })
}

// Create a matcher for dashboards and datasources
const provisioningAlertingMatcher = picomatch('**/alerting/*')
const provisioningDashboardsMatcher = picomatch('**/dashboards/*')
const provisioningDatasourcesMatcher = picomatch('**/datasources/*')

// Structured logging
const logger = pino({
    level: GRAFANA_PROVISIONING_CONFIG_RELOADER_LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
}, pinoPretty({ colorize: false, singleLine: true }))

async function main() {
    logger.info('Starting Grafana provisioning config reloader...')

    // Create a immediately resolved promise, then chain the promise
    Promise.resolve()
        .then(() => sleep(15))
        .then(() => waitforgrafana())
        .then(async () => {
            // Check if GRAFANA_PROVISIONING_CONFIG_RELOADER_SERVICE_ACCOUNT_FILE exists
            if (fs.existsSync(GRAFANA_PROVISIONING_CONFIG_RELOADER_SERVICE_ACCOUNT_FILE)) {
                logger.info("Service account already exists, reading from file")
                const bytes = fs.readFileSync(GRAFANA_PROVISIONING_CONFIG_RELOADER_SERVICE_ACCOUNT_FILE, 'utf8')
                const serviceAccount = JSON.parse(bytes)
                return serviceAccount
            }

            // Create a new service account
            logger.info('Create a new service account')
            const serviceAccount = defaultServiceAccountObject()
            const response = await request('admin/users', { method: 'POST', body: JSON.stringify(serviceAccount)})

            // Parse the response JSON
            const json = await response.json()

            // Check if the response status is not 200
            if (response.status !== 200) {
                throw new Error(json.message)
            }

            // Write the service account to the file
            logger.info('Write the service account to the file')
            fs.writeFileSync(GRAFANA_PROVISIONING_CONFIG_RELOADER_SERVICE_ACCOUNT_FILE, JSON.stringify(serviceAccount, null, 2))

            // Update account permissions
            logger.info('Update account permissions')
            const userId = json.id
            await update(`admin/users/${userId}/permissions`, { "isGrafanaAdmin": true, })

            return serviceAccount
        }) // Create service accounts
        .then((serviceAccount) => {
            // Create a base64 encoded token
            logger.info(`Generate basic auth token for user "${serviceAccount.login}"`)
            const token = generateBasicAuthToken(serviceAccount.login, serviceAccount.password)
            const Authorization = `Basic ${token}`

            // Create a debounced function to reload the Grafana configuration
            const reloadAlerting = debounce(function (event, path) {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_ALERTING_ENABLED !== 'true') { return }
                write('admin/provisioning/alerting/reload', {}, { headers: [['Authorization', Authorization]] })
                    .then(res => logger.info(res.message))
                    .catch(err => logger.warn(err))
            }, 2000)
            const reloadDashboards = debounce(function (event, path) {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_DASHBOARD_ENABLED !== 'true') { return }
                write('admin/provisioning/dashboards/reload', {}, { headers: [['Authorization', Authorization]] })
                    .then(res => logger.info(res.message))
                    .catch(err => logger.warn(err))
            }, 2000)
            const reloadDatasources = debounce(function (event, path) {
                if (GRAFANA_PROVISIONING_CONFIG_RELOADER_DATASOURCE_ENABLED !== 'true') { return }
                write('admin/provisioning/datasources/reload', {}, { headers: [['Authorization', Authorization]] })
                    .then(res => logger.info(res.message))
                    .catch(err => logger.warn(err))
            }, 2000)

            // Trigger a reload of the provisioning configuration
            logger.info("Trigger a reload of the provisioning configuration")
            reloadAlerting('fake', '/fake/alerting/reload')
            reloadDashboards('fake', '/fake/dashboards/reload')
            reloadDatasources('fake', '/fake/datasources/reload')

            // Monitor provisioning directory for changes to dashboards and datasources,
            // then reload the provisioned configuration via the Grafana API
            logger.info(`Start watching provisioning directory "${GF_PATHS_PROVISIONING}"...`)
            chokidar.watch(GF_PATHS_PROVISIONING).on('all', (event, path) => {
                logger.debug({ event, path }, "Event triggered")
                if (provisioningAlertingMatcher(path))    { reloadAlerting(event, path)   }
                if (provisioningDashboardsMatcher(path))  { reloadDashboards(event, path)  }
                if (provisioningDatasourcesMatcher(path)) { reloadDatasources(event, path) }
            })
        })
        .catch((err) => {
            logger.error(err)
            process.exit(1)
        })

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            logger.info(`Received signal: ${signal}, exiting...`)
            process.exit(0)
        })
    }

}

main()
