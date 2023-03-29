import { defineEventHandler, getCookie, setCookie } from "h3";
import { initClient } from "../../../utils/issueclient.mjs";
import { encrypt } from "../../../utils/encrypt.mjs";
import { logger } from "../../../utils/logger.mjs";
import { getRedirectUrl, getCallbackUrl, getDefaultBackUrl, getResponseMode } from "../../../utils/utils.mjs";
import jwt_decode from "jwt-decode";
import { useRuntimeConfig } from "#imports";
export default defineEventHandler(async (event) => {
  const req = event.node.req;
  const res = event.node.res;
  logger.info("[CALLBACK]: oidc/callback calling, method:" + req.method);
  let request = req;
  if (req.method === "POST") {
    const body = await readBody(event);
    request = {
      method: req.method,
      url: req.url,
      body
    };
  }
  const { op, config } = useRuntimeConfig().openidConnect;
  const responseMode = getResponseMode(config);
  const sessionid = getCookie(event, config.secret);
  const redirectUrl = getRedirectUrl(req.url);
  const callbackUrl = getCallbackUrl(op.callbackUrl, redirectUrl, req.headers.host, op.useSsl);
  const defCallBackUrl = getDefaultBackUrl(redirectUrl, req.headers.host, op.useSsl);
  const issueClient = await initClient(op, req, [defCallBackUrl, callbackUrl]);
  const params = issueClient.callbackParams(request);
  if (params.access_token) {
    logger.debug("[CALLBACK]: has access_token in params, accessToken:" + params.access_token);
    await getUserInfo(params.access_token, "");
    res.writeHead(302, { Location: redirectUrl || "/" });
    res.end();
  } else if (params.code) {
    logger.debug("[CALLBACK]: has code in params, code:" + params.code + " ,sessionid=" + sessionid);
    const tokenSet = await issueClient.callback(callbackUrl, params, { nonce: sessionid });
    console.log("token is :", isTokenExpired(tokenSet.access_token));
    if (tokenSet.access_token) {
      await getUserInfo(tokenSet.access_token, tokenSet.refresh_token);
    }
    res.writeHead(302, { Location: redirectUrl || "/" });
    res.end();
  } else {
    if (params.error) {
      logger.error("[CALLBACK]: error callback");
      logger.error(params.error + ", error_description:" + params.error_description);
      res.writeHead(302, { Location: "/oidc/error" });
      res.end();
    } else if (responseMode === "fragment") {
      logger.warn("[CALLBACK]: callback redirect");
      res.writeHead(302, { Location: "/oidc/cbt?redirect=" + redirectUrl });
      res.end();
    } else {
      logger.error("[CALLBACK]: error callback");
      res.writeHead(302, { Location: redirectUrl || "/" });
      res.end();
    }
  }
  function isTokenExpired(token) {
    const exp = jwt_decode(token).exp;
    return !(exp * 1e3 >= Date.now());
  }
  function refreshTokenPeriodically(token) {
    setInterval(() => {
      if (!isTokenExpired(token)) {
        return;
      }
      fetch(process.env.TESTING + "/protocol/openid-connect/token", {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: "quest"
        })
      }).then((response) => response.json()).then((data) => localStorage.setItem("token", data.token)).catch((error) => console.error(error));
    }, 3e4);
  }
  async function getUserInfo(accessToken, refreshToken) {
    try {
      const userinfo = await issueClient.userinfo(accessToken);
      setCookie(event, config.cookiePrefix + "access_token", accessToken, {
        maxAge: config.cookieMaxAge,
        ...config.cookieFlags["access_token"]
      });
      setCookie(event, config.cookiePrefix + "refresh_token", refreshToken, { maxAge: config.cookieMaxAge });
      const cookie = config.cookie;
      for (const [key, value] of Object.entries(userinfo)) {
        if (cookie && Object.prototype.hasOwnProperty.call(cookie, key)) {
          setCookie(event, config.cookiePrefix + key, JSON.stringify(value), {
            maxAge: config.cookieMaxAge,
            ...config.cookieFlags[key]
          });
        }
      }
      const encryptedText = await encrypt(JSON.stringify(userinfo), config);
      setCookie(event, config.cookiePrefix + "user_info", encryptedText, { ...config.cookieFlags["user_info"] });
    } catch (err) {
      logger.error("[CALLBACK]: " + err);
    }
  }
});
