/*
*
* https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
* Authors:
* Jeremy Pollock
* https://github.com/jpollock
* Jon Fawcett
* and others.
*/

var qs = require('qs');
var url = require('url');
var puppeteer = null; // Lazy load puppeteer only if needed

var helper = require('./convert');

_known_servers = {
  default: 'api.glooko.com'
, development: 'api.glooko.work'
, production: 'externalapi.glooko.com'
, eu: 'eu.api.glooko.com'
};

var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "lastGuid":"1e0c094e-1e54-4a4f-8e6a-f94484b53789" // hardcoded, random guid; no Glooko docs to explain need for param or why bad data works
, loginForm: '/users/sign_in?locale=en'  // Web login form
, login: '/users/sign_in'  // POST login with form data
, apiLogin: '/api/v2/users/sign_in'  // Original API login (kept for reference)
, mime: 'application/json'
, LatestFoods: '/api/v2/foods'
, LatestInsulins: '/api/v2/insulins'
, LatestPumpBasals: '/api/v2/pumps/scheduled_basals'
, LatestPumpBolus: '/api/v2/pumps/normal_boluses'
, LatestCGMReadings: '/api/v2/cgm/readings'  // Legacy v2 API (often empty)
, GraphCGMReadings: '/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=cgmHigh&series[]=cgmNormal&series[]=cgmLow&locale=en&insulinTooltips=true&filterBgReadings=true&splitByDay=false'  // Working Graph API with all parameters
, PumpSettings: '/api/v2/external/pumps/settings'
, v3API: '/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=automaticBolus&series[]=basalBarAutomated&series[]=basalBarAutomatedMax&series[]=basalBarAutomatedSuspend&series[]=basalLabels&series[]=basalModulation&series[]=bgAbove400&series[]=bgAbove400Manual&series[]=bgHigh&series[]=bgHighManual&series[]=bgLow&series[]=bgLowManual&series[]=bgNormal&series[]=bgNormalManual&series[]=bgTargets&series[]=carbNonManual&series[]=cgmCalibrationHigh&series[]=cgmCalibrationLow&series[]=cgmCalibrationNormal&series[]=cgmHigh&series[]=cgmLow&series[]=cgmNormal&series[]=deliveredBolus&series[]=deliveredBolus&series[]=extendedBolusStep&series[]=extendedBolusStep&series[]=gkCarb&series[]=gkInsulin&series[]=gkInsulin&series[]=gkInsulinBasal&series[]=gkInsulinBolus&series[]=gkInsulinOther&series[]=gkInsulinPremixed&series[]=injectionBolus&series[]=injectionBolus&series[]=interruptedBolus&series[]=interruptedBolus&series[]=lgsPlgs&series[]=overrideAboveBolus&series[]=overrideAboveBolus&series[]=overrideBelowBolus&series[]=overrideBelowBolus&series[]=pumpAdvisoryAlert&series[]=pumpAlarm&series[]=pumpBasaliqAutomaticMode&series[]=pumpBasaliqManualMode&series[]=pumpCamapsAutomaticMode&series[]=pumpCamapsBluetoothTurnedOffMode&series[]=pumpCamapsBoostMode&series[]=pumpCamapsDailyTotalInsulinExceededMode&series[]=pumpCamapsDepoweredMode&series[]=pumpCamapsEaseOffMode&series[]=pumpCamapsExtendedBolusNotAllowedMode&series[]=pumpCamapsManualMode&series[]=pumpCamapsNoCgmMode&series[]=pumpCamapsNoPumpConnectivityMode&series[]=pumpCamapsPumpDeliverySuspendedMode&series[]=pumpCamapsUnableToProceedMode&series[]=pumpControliqAutomaticMode&series[]=pumpControliqExerciseMode&series[]=pumpControliqManualMode&series[]=pumpControliqSleepMode&series[]=pumpGenericAutomaticMode&series[]=pumpGenericManualMode&series[]=pumpOp5AutomaticMode&series[]=pumpOp5HypoprotectMode&series[]=pumpOp5LimitedMode&series[]=pumpOp5ManualMode&series[]=reservoirChange&series[]=scheduledBasal&series[]=setSiteChange&series[]=suggestedBolus&series[]=suggestedBolus&series[]=suspendBasal&series[]=temporaryBasal&series[]=unusedScheduledBasal&locale=en-GB'
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};

function base_for (spec) {
  var server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function web_base_for (spec) {
  // For login, we need to use the web app, not API
  var server = spec.glookoEnv === 'eu' ? 'eu.my.glooko.com' : 'my.glooko.com';
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function extract_csrf_token(html) {
  // Extract authenticity_token from login form HTML
  const match = html.match(/name="authenticity_token" value="([^"]+)"/);
  return match ? match[1] : null;
}

function form_login_payload (opts, csrf_token) {
  // Create form data like the browser sends
  const params = new URLSearchParams();
  params.append('authenticity_token', csrf_token);
  params.append('redirect_to', '');
  params.append('language', 'en');
  params.append('user[email]', opts.glookoEmail);
  params.append('user[password]', opts.glookoPassword);
  params.append('commit', 'Sign In');
  return params.toString();
}

function login_payload (opts) {
  var body = {
    "userLogin": {
      "email": opts.glookoEmail,
      "password": opts.glookoPassword
    },
    "deviceInformation": {
      "deviceModel": "iPhone"
    }
  };
  return body;
}
function glookoSource (opts, axios) {
  // Check if patient ID is manually configured
  if (opts.glookoPatientId) {
    console.log("GLOOKO: Using manually configured patient ID:", opts.glookoPatientId);
  }
  
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': 'application/json, text/plain, */*',
                          'Accept-Encoding': 'gzip, deflate, br',
                          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
                          'Referer': 'https://eu.my.glooko.com/',
                          'Origin': 'https://eu.my.glooko.com',
                          'Connection': 'keep-alive',
                          'Accept-Language': 'en-GB,en;q=0.9'
                          };
  var baseURL = opts.baseURL;  // API base URL
  var webURL = web_base_for(opts);  // Web app base URL for login
  //console.log('GLOOKO OPTS', opts);
  var http = axios.create({ baseURL, headers: default_headers });
  var webHttp = axios.create({ baseURL: webURL, headers: default_headers });
  
  var impl = {
    authFromCredentials ( ) {
      // Check if patient ID is manually configured first
      if (opts.glookoPatientId) {
        console.log("GLOOKO AUTH: Using manually configured patient ID, skipping Puppeteer");
        return impl.authFromCredentialsLegacy();
      }

      console.log("GLOOKO AUTH: Using Puppeteer for automatic patient ID extraction");
      
      // Lazy load Puppeteer only when needed
      if (!puppeteer) {
        try {
          puppeteer = require('puppeteer');
        } catch (error) {
          console.log("GLOOKO AUTH: Puppeteer not available, falling back to legacy method");
          return impl.authFromCredentialsLegacy();
        }
      }

      return (async () => {
        let browser = null;
        
        try {
          console.log("GLOOKO AUTH: Launching Puppeteer browser");
          browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
          });
          
          const page = await browser.newPage();
          
          // Set user agent to match real browser
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          
          console.log("GLOOKO AUTH: Navigating to login page");
          const loginURL = webURL + '/users/sign_in?locale=en';
          await page.goto(loginURL, { waitUntil: 'networkidle2' });
          
          console.log("GLOOKO AUTH: Filling login form");
          await page.waitForSelector('input[name="user[email]"]', { timeout: 10000 });
          await page.type('input[name="user[email]"]', opts.glookoEmail);
          await page.type('input[name="user[password]"]', opts.glookoPassword);
          
          console.log("GLOOKO AUTH: Submitting login form");
          await page.click('input[type="submit"], button[type="submit"]');
          
          // Wait for login to complete - look for dashboard elements or redirects
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
          } catch (navError) {
            console.log("GLOOKO AUTH: Navigation timeout, checking if we're logged in anyway");
          }
          
          // Check if we're on the dashboard or logged in successfully
          const currentURL = page.url();
          console.log("GLOOKO AUTH: Current URL after login:", currentURL);
          
          if (currentURL.includes('/users/sign_in')) {
            throw new Error('Login failed - still on sign in page');
          }
          
          console.log("GLOOKO AUTH: Extracting patient ID from JavaScript");
          
          // Extract patient ID from window.patient or similar JavaScript variables
          const patientId = await page.evaluate(() => {
            // Try multiple sources for the patient ID
            if (typeof window.patient !== 'undefined') {
              return window.patient;
            }
            if (typeof window.current_user_glooko_code !== 'undefined') {
              return window.current_user_glooko_code;
            }
            if (typeof window.analyticsUser !== 'undefined' && window.analyticsUser.glooko_code) {
              return window.analyticsUser.glooko_code;
            }
            if (typeof window.userData !== 'undefined' && window.userData.glookoCode) {
              return window.userData.glookoCode;
            }
            
            // Look for it in the HTML content as fallback
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
              const content = script.innerHTML;
              
              // Try various patterns
              const patterns = [
                /window\.patient\s*=\s*["']([^"']+)["']/,
                /window\.current_user_glooko_code\s*=\s*["']([^"']+)["']/,
                /"glooko_code":\s*"([^"]+)"/,
                /"patient":\s*"([^"]+)"/,
                /(eu-west-1-[a-zA-Z0-9\-]+)/,
                /(us-east-1-[a-zA-Z0-9\-]+)/
              ];
              
              for (const pattern of patterns) {
                const match = content.match(pattern);
                if (match && match[1] && match[1].includes('-')) {
                  return match[1];
                }
              }
            }
            
            return null;
          });
          
          if (!patientId) {
            throw new Error('Could not extract patient ID from dashboard');
          }
          
          console.log("GLOOKO AUTH: Successfully extracted patient ID:", patientId);
          
          // Get cookies from the browser
          const cookies = await page.cookies();
          const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
          
          console.log("GLOOKO AUTH: Got session cookies from Puppeteer");
          
          await browser.close();
          
          return {
            cookies: cookieString,
            user: {
              authenticated: true,
              userLogin: {
                glookoCode: patientId
              }
            }
          };
          
        } catch (error) {
          if (browser) {
            await browser.close();
          }
          console.log("GLOOKO AUTH: Puppeteer authentication failed:", error.message);
          console.log("GLOOKO AUTH: Falling back to legacy method");
          return impl.authFromCredentialsLegacy();
        }
      })();
    },

    authFromCredentialsLegacy ( ) {
      console.log("GLOOKO AUTH: Using legacy authentication method");
      
      // Check if patient ID is manually configured
      if (opts.glookoPatientId) {
        console.log("GLOOKO AUTH: Manual patient ID configured, using web form login");
        return impl.authFromCredentialsWebForm();
      } else {
        console.log("GLOOKO AUTH: Trying original API login method");
        var payload = login_payload(opts);
        return http.post(Defaults.apiLogin, payload).then((response) => {
          console.log("GLOOKO AUTH: API login response:", response.status);
          return { cookies: response.headers['set-cookie'][0], user: response.data };
        }).catch((error) => {
          console.log("GLOOKO AUTH: API login failed:", error.response?.status, error.message);
          throw new Error('Unable to authenticate. Please add CONNECT_GLOOKO_PATIENT_ID=your-patient-id to your .env file, or install Puppeteer for automatic extraction.');
        });
      }
    },

    authFromCredentialsWebForm ( ) {
      console.log("GLOOKO AUTH: Using web form authentication with manual patient ID");
      console.log("GLOOKO AUTH: Step 1 - Getting login form for CSRF token from", webURL);
      
      // Step 1: Get login form to extract CSRF token
      return webHttp.get(Defaults.loginForm).then((formResponse) => {
        console.log("GLOOKO AUTH: Got login form, extracting CSRF token");
        const csrf_token = extract_csrf_token(formResponse.data);
        
        if (!csrf_token) {
          throw new Error('Could not extract CSRF token from login form');
        }
        console.log("GLOOKO AUTH: Extracted CSRF token");
        
        // Extract cookies from the form response to send with login POST
        const formCookies = formResponse.headers['set-cookie'];
        const cookieHeader = formCookies ? formCookies.map(cookie => cookie.split(';')[0]).join('; ') : '';
        
        console.log("GLOOKO AUTH: Step 2 - Posting login with CSRF token and cookies");
        
        // Step 2: POST login with form data, CSRF token, and cookies
        const formData = form_login_payload(opts, csrf_token);
        const loginHeaders = {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'max-age=0',
          'Referer': webURL + Defaults.loginForm,
          'Cookie': cookieHeader
        };
        
        return webHttp.post(Defaults.login, formData, { headers: loginHeaders });
      }).then((response) => {
        console.log("GLOOKO AUTH SUCCESS - Status:", response.status);
        const cookies = response.headers['set-cookie'];
        if (cookies) {
          const sessionCookie = cookies.join('; ');
          
          console.log("GLOOKO AUTH: Using manually configured patient ID:", opts.glookoPatientId);
          return {
            cookies: sessionCookie,
            user: {
              authenticated: true,
              userLogin: {
                glookoCode: opts.glookoPatientId
              }
            }
          };
        } else {
          throw new Error('No session cookies received after login');
        }
      }).catch((error) => {
        console.log("GLOOKO AUTH FAILED:");
        console.log("  Status:", error.response?.status);
        console.log("  Message:", error.message);
        throw error;
      });
    },
    sessionFromAuth (auth) {
      return Promise.resolve(auth);
    },
    dataFromSesssion (session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var maxCount = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var minutes = 5 * maxCount;
      var lastUpdatedAt = last_glucose_at.toISOString( );
      var body = { };
      var params = {
        lastGuid: Defaults.lastGuid,
        lastUpdatedAt,
        limit: maxCount,
      };

      function fetcher (endpoint) {
        var headers = Object.assign({}, default_headers);
        headers["Cookie"] = session.cookies;
        // Let axios handle the Host header automatically
        headers["Sec-Fetch-Dest"] = "empty";
        headers["Sec-Fetch-Mode"] = "cors";
        headers["Sec-Fetch-Site"] = "same-site";
        console.log('GLOOKO FETCHER LOADING', endpoint);
        console.log('GLOOKO FETCHER using base URL:', http.defaults.baseURL);
        console.log('GLOOKO FETCHER headers:', Object.keys(headers));
        
        // Only add pagination params for v2 API endpoints, not Graph API
        const requestOptions = { headers };
        if (!endpoint.includes('/api/v3/graph/data')) {
          requestOptions.params = params;
        }
        
        return http.get(endpoint, requestOptions)
          .then((resp) => {
            console.log('GLOOKO FETCHER SUCCESS:', endpoint);
            return resp.data;
          });
      }

      // 2023-06-11T00:00:00.000Z
      // 2023-06-11T23:59:59.999Z

      const myDate = new Date();
      const dateString = myDate.getFullYear() + '-'
         + ('0' + (myDate.getMonth()+1)).slice(-2) + '-'
        + ('0' + myDate.getDate()).slice(-2);

      /*
      console.log('SESSION USER', session.user);
      let v3APIURL = Defaults.v3API.replace('_PATIENT_',session.user.userLogin.glookoCode).replace('_STARTDATE_', dateString + "T00:00:00.000Z").replace('_ENDDATE_', dateString + 'T23:59:59.999Z');
      */      
      function constructUrl(endpoint) {
        //?patient=orange-waywood-8651&startDate=2020-01-08T06:07:00.000Z&endDate=2020-01-09T06:07:00.000Z
        const myDate = new Date();
        const startDate = new Date(two_days_ago); // myDate.getTime() - 6 * 60 * 60 * 1000);

        // Replace placeholders if they exist, otherwise append as query parameters
        if (endpoint.includes('_PATIENT_')) {
          return endpoint
            .replace('_PATIENT_', session.user.userLogin.glookoCode)
            .replace('_STARTDATE_', startDate.toISOString())
            .replace('_ENDDATE_', myDate.toISOString());
        } else {
          const url = endpoint + "?patient=" + session.user.userLogin.glookoCode
           + "&startDate=" + startDate.toISOString()
           + "&endDate=" + myDate.toISOString();
          return url;
        }
      }

      return Promise.all([
        //fetcher(v3APIURL)
        //fetcher(constructUrl(Defaults.LatestFoods)),
        //fetcher(constructUrl(Defaults.LatestInsulins)),
        fetcher(constructUrl(Defaults.LatestPumpBasals)),
        fetcher(constructUrl(Defaults.LatestPumpBolus)),
        fetcher(constructUrl(Defaults.GraphCGMReadings)),
        //fetcher(constructUrl(Defaults.PumpSettings))
        ]).then(function (results) {
          //console.log(results);
          
          // Extract CGM readings from Graph API response
          var cgmReadings = [];
          if (results[2] && results[2].series) {
            const { cgmHigh, cgmNormal, cgmLow } = results[2].series;
            
            // Combine all CGM readings from different series
            [cgmHigh, cgmNormal, cgmLow].forEach(series => {
              if (series && Array.isArray(series)) {
                series.forEach(point => {
                  if (point && point.timestamp && point.y) {
                    // Graph API timestamps come in Finland time (UTC+3) but marked as UTC
                    // Convert to actual UTC by subtracting 3 hours
                    const moment = require('moment');
                    const utcTimestamp = moment(point.timestamp).subtract(3, 'hours').toISOString();
                    cgmReadings.push({
                      timestamp: utcTimestamp,
                      value: point.y,
                      deviceModel: 'cgm'
                    });
                  }
                });
              }
            });
            
            // Sort by timestamp
            cgmReadings.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          }
          
          console.log('GLOOKO Graph API: Extracted', cgmReadings.length, 'CGM readings');
          
         var some = {
            //food: results[0].foods,
            //insulins: results[1].insulins,
            scheduledBasals: results[0].scheduledBasals,
            normalBoluses: results[1].normalBoluses,
            readings: cgmReadings
            //settings: results[4].pumpSettings
         };

         //console.log('food sample', JSON.stringify(some.food[0]));
         //console.log('insulins sample', JSON.stringify(some.insulins[0]));
         //console.log('scheduledBasals sample', JSON.stringify(some.scheduledBasals[0]));
         //console.log('normalBoluses sample', JSON.stringify(some.normalBoluses[0]));
         //console.log('readings sample', JSON.stringify(some.readings[0]));
         //console.log('settings sample', JSON.stringify(results[4]));

          //console.log('GLOOKO DATA FETCH', results, some);
          //console.log('GOT RESULTS FROM GLOOKO', results);
          return some;
        });
    },
    align_to_glucose ( ) {
      // TODO
    },
    transformData (batch) {
      console.log('GLOOKO passing batch for transforming');
      console.log('GLOOKO batch contains:', Object.keys(batch));
      
      var treatments = helper.generate_nightscout_treatments(batch, opts.glookoTimezoneOffset);
      var entries = helper.generate_nightscout_entries(batch, opts.glookoTimezoneOffset);
      
      return { entries, treatments };
    },
  };
  function tracker_for ( ) {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 24 * 1) - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      }
    });

    builder.register_loop('Glooko', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformData,
        backoff: {
        // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000

        },
        // only try 3 times to get data
        maxRetries: 1
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  }
  impl.generate_driver = generate_driver;
  return impl;
}

glookoSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);

  const offset = !isNaN(input.glookoTimezoneOffset) ? input.glookoTimezoneOffset * -60 * 60 * 1000 : 0
  console.log('GLOOKO using ms offset:', offset, input.glookoTimezoneOffset);

  var config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
    glookoPatientId: input.glookoPatientId,
    glookoTimezoneOffset: offset,
    baseURL
  };
  var errors = [ ];
  if (!config.glookoEmail) {
    errors.push({desc: "The Glooko User Login Email is required.. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.", err: new Error('CONNECT_GLOOKO_EMAIL') } );
  }
  if (!config.glookoPassword) {
    errors.push({desc: "Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.", err: new Error('CONNECT_GLOOKO_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'glooko' : 'disabled';
  return { ok, errors, config };
}
module.exports = glookoSource;
