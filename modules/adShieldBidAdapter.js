// @ts-check
import {
  deepAccess,
  getWindowTop,
  isArray,
  isEmpty,
  logError,
  logInfo,
  safeJSONEncode,
  deepClone,
  // deepSetValue,
} from "../src/utils.js";
import { registerBidder } from "../src/adapters/bidderFactory.js";
import { config } from "../src/config.js";
import { BANNER, NATIVE, VIDEO } from "../src/mediaTypes.js";
import { getRefererInfo } from "../src/refererDetection.js";
import { getGlobal } from "../src/prebidGlobal.js";
import { getGptSlotInfoForAdUnitCode } from "../libraries/gptUtils/gptUtils.js";
// import { ajax } from "../src/ajax.js";
import { getViewportCoordinates } from "../libraries/viewport/viewport.js";
import { ortbConverter } from "../libraries/ortbConverter/converter.js";

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 * @typedef {import('../src/adapters/bidderFactory.js').ServerRequest} ServerRequest
 * @typedef {import('../src/adapters/bidderFactory.js').ServerResponse} ServerResponse
 * @typedef {import('../src/adapters/bidderFactory.js').SyncOptions} SyncOptions
 * @typedef {import('../src/adapters/bidderFactory.js').UserSync} UserSync
 */

/**
 * @typedef {object} refererInfo
 *
 * @property {string | null} canonicalUrl
 * @property {string} page
 * @property {string} domain
 * @property {string | null} referer
 * @property {number} numIframes
 * @property {boolean} reachedTop
 * @property {boolean} isAmp
 * @property {string[]} stack
 * {
    canonicalUrl: null,
    page: "http://mypage.org?pbjs_debug=true",
    domain: "mypage.org",
    referer: null,
    numIframes: 0,
    reachedTop: true,
    isAmp: false,
    stack: ["http://mypage.org?pbjs_debug=true"]
  }
 */

/**
 * @typedef {object} BidderRequest
 *
 * @property {string} auctionId
 * @property {number} auctionStart
 * @property {string} bidderCode
 * @property {string} bidderRequestId
 * @property {Bid[]} bids
 * @property {object} gdprConsent
 * @property {object} ortb2
 * @property {object} refererInfo
 *
 * @example
 * {
    auctionId: "b06c5141-fe8f-4cdf-9d7d-54415490a917",
    auctionStart: 1579746300522,
    bidderCode: "myBidderCode",
    bidderRequestId: "15246a574e859f",
    bids: [{...}],
    gdprConsent: {consentString: "BOtmiBKOtmiBKABABAENAFAAAAACeAAA", vendorData: {...}, gdprApplies: true},
    ortb2: {...},
    refererInfo: {
      canonicalUrl: null,
      page: "http://mypage.org?pbjs_debug=true",
      domain: "mypage.org",
      referer: null,
      numIframes: 0,
      reachedTop: true,
      isAmp: false,
      stack: ["http://mypage.org?pbjs_debug=true"]
    }
  }
 */

const BIDDER_CODE = "adshield";
const BID_URL = "http://localhost:8788/ortb";

export const EVENTS = {
  TIMEOUT_EVENT_NAME: "client_timeout",
  BID_WON_EVENT_NAME: "client_bid_won",
  SET_TARGETING: "client_set_targeting",
  BIDDER_ERROR: "client_bidder_error",
};

// TODO: change this
export const EVENT_PIXEL_URL = "https://navvy.media.net/log";
const DEFAULT_CURRENCY = "USD";

let pageMeta;

const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 30,
  },
  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);
    if (!imp.bidfloor) {
      imp.bidfloor = bidRequest.params.bidfloor || 0;
      imp.bidfloorcur = bidRequest.params.currency || DEFAULT_CURRENCY;
    }
    if (bidRequest.params.battr) {
      Object.keys(bidRequest.mediaTypes).forEach((mType) => {
        imp[mType].battr = bidRequest.params.battr;
      });
    }
    return imp;
  },
  request(buildRequest, imps, bidderRequest, context) {
    const request = buildRequest(imps, bidderRequest, context);
    const bid = context.bidRequests[0];
    if (!request.cur) {
      request.cur = [bid.params.currency || DEFAULT_CURRENCY];
    }
    if (bid.params.bcat) {
      request.bcat = bid.params.bcat;
    }
    return request;
  },
  bidResponse(buildBidResponse, bid, context) {
    const { bidRequest } = context;

    let resMediaType;
    const reqMediaTypes = Object.keys(bidRequest.mediaTypes);
    if (reqMediaTypes.length === 1) {
      resMediaType = reqMediaTypes[0];
    } else {
      if (bid.adm.search(/^(<\?xml|<vast)/i) !== -1) {
        resMediaType = VIDEO;
      } else if (bid.adm[0] === "{") {
        resMediaType = NATIVE;
      } else {
        resMediaType = BANNER;
      }
    }

    context.mediaType = resMediaType;
    context.cpm = bid.price;

    const bidResponse = buildBidResponse(bid, context);
    return bidResponse;
  },
});

function getPageMeta() {
  if (pageMeta) {
    return pageMeta;
  }
  let canonicalUrl = getUrlFromSelector('link[rel="canonical"]', "href");
  let ogUrl = getUrlFromSelector('meta[property="og:url"]', "content");
  let twitterUrl = getUrlFromSelector('meta[name="twitter:url"]', "content");

  pageMeta = Object.assign(
    {},
    canonicalUrl && { canonical_url: canonicalUrl },
    ogUrl && { og_url: ogUrl },
    twitterUrl && { twitter_url: twitterUrl }
  );

  return pageMeta;
}

function getUrlFromSelector(selector, attribute) {
  let attr = getAttributeFromSelector(selector, attribute);
  return attr && getAbsoluteUrl(attr);
}

function getAttributeFromSelector(selector, attribute) {
  try {
    let doc = getWindowTop().document;
    let element = doc.querySelector(selector);
    if (element !== null && element[attribute]) {
      return element[attribute];
    }
  } catch (e) {}
}

function getAbsoluteUrl(url) {
  let aTag = getWindowTop().document.createElement("a");
  aTag.href = url;

  return aTag.href;
}

function getWindowSize() {
  return {
    w: window.screen.width || -1,
    h: window.screen.height || -1,
  };
}

function extParams(bidRequest, bidderRequests) {
  const params = deepAccess(bidRequest, "params");
  const gdpr = deepAccess(bidderRequests, "gdprConsent");
  const uspConsent = deepAccess(bidderRequests, "uspConsent");
  const userId = deepAccess(bidRequest, "userId");
  const sChain = deepAccess(bidRequest, "schain") || {};
  const windowSize = spec.getWindowSize();
  const gdprApplies = !!(gdpr && gdpr.gdprApplies);
  const uspApplies = !!uspConsent;
  const coppaApplies = !!config.getConfig("coppa");
  const {
    top = -1,
    right = -1,
    bottom = -1,
    left = -1,
  } = getViewportCoordinates();
  return Object.assign(
    {},
    { customer_id: params.cid },
    { prebid_version: "v" + "$prebid.version$" },
    { gdpr_applies: gdprApplies },
    gdprApplies && { gdpr_consent_string: gdpr.consentString || "" },
    { usp_applies: uspApplies },
    uspApplies && { usp_consent_string: uspConsent || "" },
    { coppa_applies: coppaApplies },
    windowSize.w !== -1 && windowSize.h !== -1 && { screen: windowSize },
    userId && { user_id: userId },
    getGlobal().medianetGlobals.analyticsEnabled && { analytics: true },
    !isEmpty(sChain) && { schain: sChain },
    {
      vcoords: {
        top_left: { x: left, y: top },
        bottom_right: { x: right, y: bottom },
      },
    }
  );
}

/**
 * @return {string}
 */
function getBidderURL() {
  return BID_URL;
}

function isValidBid(bid) {
  return true;
  // return bid.no_bid === false && parseFloat(bid.cpm) > 0.0;
}

function getEventData(event) {
  const params = {};
  const referrerInfo = getRefererInfo();
  params.logid = "kfk";
  params.evtid = "projectevents";
  params.project = "prebid";
  params.pbver = "$prebid.version$";
  // params.cid = getGlobal().medianetGlobals.cid || "";
  params.dn = encodeURIComponent(referrerInfo.domain || "");
  params.requrl = encodeURIComponent(referrerInfo.page || "");
  params.event = event.name || "";
  params.value = event.value || "";
  params.rd = event.related_data || "";
  return params;
}

function getBidData(bid) {
  const params = {};
  params.acid = bid.auctionId || "";
  params.crid =
    deepAccess(bid, "params.crid") ||
    deepAccess(bid, "params.0.crid") ||
    bid.adUnitCode ||
    "";
  params.ext = safeJSONEncode(bid.ext) || "";

  const rawobj = deepClone(bid);
  delete rawobj.ad;
  delete rawobj.vastXml;
  params.rawobj = safeJSONEncode(rawobj);
  return params;
}

function getLoggingData(event, bids) {
  const logData = {};
  if (!isArray(bids)) {
    bids = [];
  }
  bids.forEach((bid) => {
    let bidData = getBidData(bid);
    Object.keys(bidData).forEach((key) => {
      logData[key] = logData[key] || [];
      logData[key].push(encodeURIComponent(bidData[key]));
    });
  });
  return Object.assign({}, getEventData(event), logData);
}

// function fireAjaxLog(url, payload) {
//   ajax(
//     url,
//     {
//       success: () => undefined,
//       error: () => undefined,
//     },
//     payload,
//     {
//       method: "POST",
//       keepalive: true,
//     }
//   );
// }

function logEvent(event, data) {
  const logData = getLoggingData(event, data);
  console.log("logData", logData);
  // fireAjaxLog(EVENT_PIXEL_URL, formatQS(logData));
}

function clearPageMeta() {
  pageMeta = undefined;
}

export const spec = {
  code: BIDDER_CODE,
  gvlid: 1385, // IAB Global Vendor List ID
  supportedMediaTypes: [BANNER, VIDEO],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid (if cid is present), and false otherwise.
   */
  isBidRequestValid: function (bid) {
    // TODO: validate bid request
    return true;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @param {BidderRequest} bidderRequest
   * @return {ServerRequest} ServerRequest Info describing the request to the server.
   */
  buildRequests: function (bidRequests, bidderRequest) {
    logInfo(
      "bidRequests",
      bidRequests.map((b) => ({ ...b }))
    );
    logInfo("bidderRequest", { ...bidderRequest });
    const payload = converter.toORTB({ bidRequests, bidderRequest });

    logInfo("payload", payload);

    return {
      method: "POST",
      url: getBidderURL(),
      data: payload,
      options: {
        contentType: "application/json",
        withCredentials: true,
        customHeaders: {
          "x-adshield-app": "prebid/adshieldBidAdapter",
          "x-openrtb-version": 2.5,
        },
      },
    };
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {ServerResponse} response A successful response from the server.
   * @param {BidRequest} request
   * @returns {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (response, request) {
    if (!response || !response.body) {
      logInfo(`${BIDDER_CODE} : response is empty`);
      return [];
    }

    /** @type {Bid[]} */
    let validBids = [];

    let bids = converter.fromORTB({
      request: request.data,
      response: response.body,
    });

    logInfo("Received bids", bids);

    if (!isArray(bids) || bids.length === 0) {
      logInfo(`${BIDDER_CODE} : no bids`);
    } else {
      validBids = bids.filter((bid) => isValidBid(bid));
    }
    // NOTE: Previously, fledgeAuctionConfigs existed, which was for Protected Audience API (PAAPI) support
    // We currently don't support PAAPI, so it has been removed. If needed in the future, it should be added back
    return validBids;
  },

  /**
   * @param {SyncOptions} syncOptions
   * @param {ServerResponse[]} serverResponses
   * @return {string[]}
   * @description For now, we don't need to support user syncs.
   */
  getUserSyncs: function (syncOptions, serverResponses) {
    return [];
  },

  // onTimeout: (timeoutData) => {
  //   try {
  //     let eventData = {
  //       name: EVENTS.TIMEOUT_EVENT_NAME,
  //       value: timeoutData.length,
  //       related_data:
  //         timeoutData[0].timeout || config.getConfig("bidderTimeout"),
  //     };
  //     logEvent(eventData, timeoutData);
  //   } catch (e) {}
  // },

  /**
   * @param {Bid} bid
   */
  onBidWon: (bid) => {
    try {
      let eventData = {
        name: EVENTS.BID_WON_EVENT_NAME,
        value: bid.cpm,
      };
      logEvent(eventData, [bid]);
    } catch (e) {}
  },

  // onSetTargeting: (bid) => {
  //   try {
  //     let eventData = {
  //       name: EVENTS.SET_TARGETING,
  //       value: bid.cpm,
  //     };
  //     const enableSendAllBids = config.getConfig("enableSendAllBids");
  //     if (!enableSendAllBids) {
  //       logEvent(eventData, [bid]);
  //     }
  //   } catch (e) {}
  // },

  onBidderError: ({ error, bidderRequest }) => {
    try {
      let eventData = {
        name: EVENTS.BIDDER_ERROR,
        related_data: `timedOut:${error.timedOut}|status:${error.status}|message:${error.reason.message}`,
      };
      logEvent(eventData, bidderRequest.bids);
    } catch (e) {}
  },

  clearPageMeta,

  getWindowSize,
};
registerBidder(spec);
