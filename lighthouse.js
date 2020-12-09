const lighthouse = require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const argv = require('yargs').argv;
const url = require('url');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const DEVTOOLS_RTT_ADJUSTMENT_FACTOR = 3.75;
const DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR = 0.9;
const throttling = {
  DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
  DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  // These values align with WebPageTest's definition of "Fast 3G"
  // But offer similar charateristics to roughly the 75th percentile of 4G connections.
  mobileSlow4G: {
    rttMs: 150,
    throughputKbps: 1.6 * 1024,
    requestLatencyMs: 150 * DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    downloadThroughputKbps: 1.6 * 1024 * DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
    uploadThroughputKbps: 750 * DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
    cpuSlowdownMultiplier: 4,
  },
  // These values partially align with WebPageTest's definition of "Regular 3G".
  // These values are meant to roughly align with Chrome UX report's 3G definition which are based
  // on HTTP RTT of 300-1400ms and downlink throughput of <700kbps.
  mobileRegular3G: {
    rttMs: 300,
    throughputKbps: 700,
    requestLatencyMs: 300 * DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    downloadThroughputKbps: 700 * DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
    uploadThroughputKbps: 700 * DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
    cpuSlowdownMultiplier: 4,
  },
  // Using a "broadband" connection type
  // Corresponds to "Dense 4G 25th percentile" in https://docs.google.com/document/d/1Ft1Bnq9-t4jK5egLSOc28IL4TvR-Tt0se_1faTA4KTY/edit#heading=h.bb7nfy2x9e5v
  desktopDense4G: {
    rttMs: 40,
    throughputKbps: 10 * 1024,
    cpuSlowdownMultiplier: 1,
    requestLatencyMs: 0, // 0 means unset
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
};
const config = {
  extends: 'lighthouse:default',
  settings: {
    // onlyCategories: ['performance','seo'],
    emulatedFormFactor: 'desktop',
    throttling: throttling.mobileRegular3G
  }
};
const launchChromeAndRunLighthouse = (url) => {
  return chromeLauncher.launch().then(chrome => {
    const opts =  {
      port: chrome.port,
      // output: 'html'
    }
    return lighthouse(url, opts, config).then(results => {
      return chrome.kill().then(() => {
        // fs.writeFileSync('lhreport.html', results.report  );
        return {
          js: results.lhr,
          json: results.report
        }
      });
    });
  });
}

const getContents = (pathStr) => {
  const output = fs.readFileSync(pathStr, 'utf8', (err, results) => {
    return results;
  });
  return JSON.parse(output);
};

const compareReports = (from, to) => {
  const metricFilter = [
    'first-contentful-paint',
    'first-meaningful-paint',
    'speed-index',
    'estimated-input-latency',
    'total-blocking-time',
    'max-potential-fid',
    'time-to-first-byte',
    'first-cpu-idle',
    'interactive'
  ]

  const calcPercentageDiff = (from, to) => {
    const per = ((to - from) / from) * 100;
    return Math.round(per * 100) / 100;
  };

  for(let auditObj in from['audits']) {
    if(metricFilter.includes(auditObj)) {
      const percentageDiff = calcPercentageDiff(
        from['audits'][auditObj].numericValue,
        to['audits'][auditObj].numericValue
      );

      let logColor = '\x1b[37m';
      const log = (() => {
        if(Math.sign(percentageDiff) === 1) {
          logColor = "\x1b[31m";
          return `${percentageDiff.toString().replace('-','') + '%'} slower`;
        }
        else if(Math.sign(percentageDiff) === 0) {
          return 'unchanged';
        }
        else {
          logColor = "\x1b[32m";
          return `${percentageDiff.toString().replace('-','') + '%'} faster`;
        }
      })();
      console.log(logColor, `${from['audits'][auditObj].title} is ${log}`);
    }
  }
}

if(argv.from && argv.to) {
  compareReports(
    getContents(argv.from + '.json'),
    getContents(argv.to + '.json')
  );
}
else if(argv.url) {
  const urlObj = new URL(argv.url);
  let dirName = urlObj.host.replace('www.','');
  if(urlObj.pathname !== '/') {
    dirName = dirName + urlObj.pathname.replace(/\//g,'_');
  }

  if(!fs.existsSync(dirName)) {
    fs.mkdirSync(dirName);
  }

  launchChromeAndRunLighthouse(argv.url).then(results => {
    const prevReports = glob(`${dirName}/*.json`, {
      sync: true
    });

    if(prevReports.length) {
      dates = [];
      for(report in prevReports) {
        dates.push(new Date(path.parse(prevReports[report]).name.replace(/_/g, ':')));
      }
      const max = dates.reduce(function(a, b) {
        return Math.max(a, b);
      });
      const recentReport = new Date(max).toISOString();

      const recentReportContents = getContents(dirName + '/' + recentReport.replace(/:/g, '_') + '.json');

      compareReports(recentReportContents, results.js);
    }

    fs.writeFile(`${dirName}/${results.js['fetchTime'].replace(/:/g, '_')}.json`, results.json, (err) => {
      if (err) throw err;
    });
  });
}
else {
  throw "You haven't passed a URL to Lighthouse";
}
