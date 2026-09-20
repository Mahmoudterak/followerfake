// GET /api/instagram?handle=<username>
// يجلب بيانات حساب احترافي (Business / Creator) عبر Meta Graph API — Business Discovery.
//
// المتغير المطلوب في إعدادات Vercel:
//   IG_ACCESS_TOKEN  رمز الوصول (رمز مستخدم أو رمز صفحة). معرّف حساب إنستغرام يُستخرج منه تلقائيًا.
// اختياريان:
//   IG_USER_ID       لتحديد الحساب يدويًا إن كان الرمز مرتبطًا بأكثر من صفحة.
//   IG_GRAPH_VERSION الإصدار (الافتراضي v23.0)

const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

// يُحفظ المعرّف بين الطلبات ما دامت النسخة الحية للدالة قائمة
var cachedUserId = null;
// هل يدعم Business Discovery الحقل follows_count؟ (null = لم يُعرف بعد)
var followsSupported = null;

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache || "no-store");
  res.end(JSON.stringify(body));
}

function average(values) {
  if (!values.length) return null;
  var sum = 0;
  for (var i = 0; i < values.length; i++) sum += values[i];
  return Math.round((sum / values.length) * 10) / 10;
}

function validCount(n) {
  return typeof n === "number" && isFinite(n) && n >= 0;
}

// معامل التباين (الانحراف المعياري ÷ المتوسط) لقيم الإعجابات؛ يقيس اتساق الأداء بين المنشورات
function variation(values) {
  if (values.length < 3) return null;
  var mean = 0;
  for (var i = 0; i < values.length; i++) mean += values[i];
  mean = mean / values.length;
  if (mean <= 0) return null;
  var sq = 0;
  for (var j = 0; j < values.length; j++) sq += (values[j] - mean) * (values[j] - mean);
  return Math.round((Math.sqrt(sq / values.length) / mean) * 100) / 100;
}

function buildFields(handle, withFollows) {
  return (
    "business_discovery.username(" + handle + "){" +
    "username,name,biography,website,profile_picture_url,followers_count," +
    (withFollows ? "follows_count," : "") +
    "media_count,media.limit(25){like_count,comments_count,timestamp}}"
  );
}

function safeUrl(u) {
  return typeof u === "string" && u.indexOf("https://") === 0 && u.length < 2000 ? u : null;
}

async function graph(version, path, params) {
  var qs = new URLSearchParams(params).toString();
  var url = "https://graph.facebook.com/" + version + "/" + path + "?" + qs;
  var r = await fetch(url, { headers: { Accept: "application/json" } });
  var j = await r.json();
  return { ok: r.ok && !j.error, json: j, error: j.error || {} };
}

// يستخرج معرّف حساب إنستغرام الاحترافي من الرمز نفسه
async function resolveIgUserId(version, token) {
  if (process.env.IG_USER_ID) return { id: process.env.IG_USER_ID };
  if (cachedUserId) return { id: cachedUserId };

  // رمز صفحة: /me هو الصفحة نفسها
  var me = await graph(version, "me", { fields: "instagram_business_account", access_token: token });
  var id = me.ok && me.json.instagram_business_account && me.json.instagram_business_account.id;

  // رمز مستخدم: نبحث في الصفحات التي يديرها (الحقل غير موجود على المستخدم فيرجع الخطأ 100)
  if (!id && (me.ok || me.error.code === 100)) {
    var pages = await graph(version, "me/accounts", { fields: "instagram_business_account", access_token: token });
    if (!pages.ok) return { error: pages.error };
    var list = pages.json.data || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].instagram_business_account && list[i].instagram_business_account.id) {
        id = list[i].instagram_business_account.id;
        break;
      }
    }
  } else if (!id && !me.ok) {
    return { error: me.error };
  }

  if (!id) return { error: { code: "no_ig_account" } };
  cachedUserId = id;
  return { id: id };
}

// يحوّل خطأ Graph إلى استجابة مناسبة دون تسجيل الرمز أو نص الخطأ
function sendGraphError(res, err) {
  console.error("graph_error", err.code, err.error_subcode);
  if (err.code === "no_ig_account") return send(res, 503, { error: "no_instagram_account" });
  if (err.code === 190) return send(res, 502, { error: "token_invalid" });
  if (err.code === 4 || err.code === 17 || err.code === 32 || err.code === 613) {
    return send(res, 429, { error: "rate_limited" });
  }
  if (err.code === 110 || err.code === 100) {
    return send(res, 404, { error: "not_professional_or_not_found" });
  }
  return send(res, 502, { error: "upstream_error" });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

  var handle = String((req.query && req.query.handle) || "").trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) return send(res, 400, { error: "invalid_handle" });

  var token = process.env.IG_ACCESS_TOKEN;
  if (!token) return send(res, 503, { error: "not_configured" });

  var version = process.env.IG_GRAPH_VERSION || "v23.0";

  try {
    var who = await resolveIgUserId(version, token);
    if (who.error) return sendGraphError(res, who.error);

    var withFollows = followsSupported !== false;
    var result = await graph(version, encodeURIComponent(who.id), {
      fields: buildFields(handle, withFollows),
      access_token: token
    });

    // إن رفض إنستغرام الحقل follows_count نعيد المحاولة بدونه ونتذكر ذلك
    if (!result.ok && withFollows && result.error.code === 100) {
      var retry = await graph(version, encodeURIComponent(who.id), {
        fields: buildFields(handle, false),
        access_token: token
      });
      if (retry.ok) followsSupported = false;
      result = retry;
    } else if (result.ok && withFollows) {
      followsSupported = true;
    }

    if (!result.ok) {
      // إن تغيّر الحساب المرتبط بالرمز نُعيد الاستخراج في الطلب التالي
      if (result.error.code === 190) cachedUserId = null;
      return sendGraphError(res, result.error);
    }

    var bd = result.json.business_discovery;
    if (!bd || !validCount(bd.followers_count)) {
      return send(res, 404, { error: "not_professional_or_not_found" });
    }

    var items = (bd.media && bd.media.data) || [];
    var likes = [];
    var comments = [];
    for (var i = 0; i < items.length; i++) {
      if (validCount(items[i].like_count)) likes.push(items[i].like_count);
      if (validCount(items[i].comments_count)) comments.push(items[i].comments_count);
    }

    return send(
      res,
      200,
      {
        handle: bd.username || handle,
        name: bd.name || null,
        followers: bd.followers_count,
        mediaCount: validCount(bd.media_count) ? bd.media_count : 0,
        sampleSize: items.length,
        likesSample: likes.length,
        avgLikes: average(likes),
        avgComments: average(comments),
        likesCv: variation(likes),
        following: validCount(bd.follows_count) ? bd.follows_count : null,
        profilePicture: safeUrl(bd.profile_picture_url),
        hasBio: typeof bd.biography === "string" && bd.biography.trim().length > 0,
        hasWebsite: typeof bd.website === "string" && bd.website.trim().length > 0,
        fetchedAt: new Date().toISOString()
      },
      "public, s-maxage=3600, stale-while-revalidate=600"
    );
  } catch (e) {
    console.error("graph_request_failed", e && e.name);
    return send(res, 502, { error: "upstream_error" });
  }
};
