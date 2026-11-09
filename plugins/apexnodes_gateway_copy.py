"""Every sentence the APEX platform tool gateway client writes itself, as (zh, en).

The client next to this file imports it as ``_COPY``; its ``say()`` picks the language and
fills the fields. Kept in its own file so the client stays under its line cap (hc-1035,
2026-11-05). Data only: no imports, no credentials, no requests (the Desktop credential
audit in ``apps/desktop/electron/apex-platform-tools.ts`` reads every shared module here, and
naming the client would make it look for a credential chain in this one).
"""

from __future__ import annotations

# Every sentence this client (and the apexnodes image/video tools through it) writes
# itself, as (zh, en). The language is the user's: HERMES_LANGUAGE, then
# display.language in config.yaml (the Desktop writes zh by default and the user can
# switch to English), Chinese unless that is English. The hosted copies in apex-nodes
# use the same rule (hc-961 sets zh there). The server's own sentences are passed on
# as they are. ``{label}`` / ``{Label}`` name the media (图片/视频, image/video).
COPY: dict[str, tuple[str, str]] = {
    "credential_missing_desktop": (
        "尚未登录 ApexNodes 账号,平台工具(图片/视频生成、图片 OCR、媒体转写)不可用。"
        "请打开 设置 → 账户 完成登录;登录后本对话直接重试即可,无需其他配置。",
        "You are not signed in to ApexNodes, so platform tools (image/video generation, image OCR, "
        "media transcription) are unavailable. Open Settings → Account and sign in; then simply try "
        "again in this chat, nothing else to set up.",
    ),
    "credential_missing_container": (
        "本环境没有平台凭据,平台工具不可用。请为容器注入 {env_key}(或 API_SERVER_KEY),再重启 Agent 容器。",
        "This environment has no platform credential, so platform tools are unavailable. Inject "
        "{env_key} (or API_SERVER_KEY) into the container and restart the Agent container.",
    ),
    "credential_stale_config": (
        "平台凭据被服务端拒绝(401);当前用的是 config.yaml 里的备用副本,它可能已经过期。"
        "请先把 APEX 更新到最新版并重启(桌面端会在启动时自动换发凭据);若更新后仍然如此,"
        "再到 设置 → 账户 重新登录一次。",
        "The server rejected the platform credential (401). The one in use is the backup copy in "
        "config.yaml, which may have expired. Update APEX to the latest version and restart it (the "
        "Desktop re-issues the credential at start-up); if it still happens, sign in again under "
        "Settings → Account.",
    ),
    "credential_stale_desktop": (
        "平台凭据被服务端拒绝(401)。请到 设置 → 账户 重新登录一次以换发凭据;"
        "若刚登录过仍然如此,请重启 APEX(启动时会自动换发)。",
        "The server rejected the platform credential (401). Sign in again under Settings → Account "
        "to get a new one; if you just did, restart APEX (it re-issues the credential at start-up).",
    ),
    "credential_stale_container": (
        "平台凭据被服务端拒绝(401):该 Agent Key 可能已轮换或被停用,请管理员重新下发 Agent Key 后重启容器。",
        "The server rejected the platform credential (401): this Agent Key may have been rotated or "
        "disabled. An admin needs to issue a new Agent Key and restart the container.",
    ),
    "quota_402": (
        "平台工具额度不足(402):套餐配额已用尽或余额不足,请升级套餐/充值后再试。",
        "Not enough platform tool quota (402): the plan's allowance or the balance has run out. "
        "Upgrade the plan or top up, then try again.",
    ),
    "too_large_413": (
        "文件超过平台大小上限(413),本次未能处理。",
        "The file is over the platform's size limit (413) and was not processed.",
    ),
    "rate_limited_429": (
        "平台工具请求过于频繁(429):已自动退避重试仍被限流,请稍等 1-2 分钟再试。",
        "Too many platform tool requests (429): still rate-limited after backing off. Wait 1-2 "
        "minutes and try again.",
    ),
    # hc-1035: a 503 is said only for the platform being unable to serve; the server
    # answers a link, parameter or rate-limit problem with a 4xx and its own sentence.
    "download_unavailable_503": (
        "视频链接解析/下载服务暂不可用(503),请过几分钟再试，或直接上传视频文件。",
        "The video link resolving/download service is unavailable right now (503). Try again in a "
        "few minutes, or upload the video file directly.",
    ),
    "asr_unavailable_503": (
        "视频转写服务暂不可用(503),请过几分钟再试，或先提供已有文字稿。",
        "The video transcription service is unavailable right now (503). Try again in a few minutes, "
        "or provide an existing transcript first.",
    ),
    # hc-1035: Volcengine timed out its own recognition task (55001010). The platform is up;
    # the same file again usually works. A link to the same video is the same audio, so the
    # model must not switch to the URL (2026-11-04/05 sessions did). Nothing resubmits by itself.
    "asr_vendor_timeout": (
        "转写服务这次的识别任务在供应商那边超时了，没出结果，也没计费；平台没停。"
        "用同一个文件再调一次 media_transcribe 通常就行；换成这条视频的链接还是同一段音频，没有帮助。",
        "The transcription vendor timed out on this recognition task, so there is no result and nothing was "
        "billed; the platform is up. Calling media_transcribe again with the same file usually works; a link to "
        "the same video is the same audio and will not help.",
    ),
    "capability_unavailable_503": (
        "平台能力暂不可用(503),请过几分钟再试。",
        "This platform capability is unavailable right now (503). Try again in a few minutes.",
    ),
    "capability_busy_503": (
        "平台的数据服务这会儿排队的请求太多(503),这次没轮到；过 1 分钟再试。",
        "The platform's data service has too many requests queued right now (503); try again in "
        "about a minute.",
    ),
    "capability_setup_503": (
        "平台这项能力的配置出了问题(503),要等平台修好才能用，现在重试也不会成功。",
        "This platform capability is misconfigured (503) and works again only once the platform "
        "fixes it; retrying now will not help.",
    ),
    "gateway_error_status": ("平台工具网关返回错误(HTTP {status})", "The platform tool gateway returned an error (HTTP {status})"),
    "with_detail": ("{message}(详情: {detail})", "{message} (details: {detail})"),
    "gateway_unconfigured": (
        "平台工具网关未配置(缺 {env_base},亦未检测到桌面登录凭证),无法调用平台能力。",
        "The platform tool gateway is not configured ({env_base} is missing and no Desktop sign-in "
        "was found), so platform capabilities cannot be called.",
    ),
    "network_error": (
        "无法连接平台服务(网络错误):{error}。请检查网络/代理后重试;凭据本身没有问题。",
        "Could not reach the platform service (network error): {error}. Check the network or proxy "
        "and try again; the credential itself is fine.",
    ),
    # hc-984: no retry promise for an answer nobody could read.
    "gateway_unreadable": (
        "平台工具网关的回答读不出来,这次没有结果。",
        "The platform tool gateway sent an answer that could not be read; there is no result this time.",
    ),
    # hc-978: what the agent can do next when a transcription job's answer is out of reach.
    "asr_job_unreachable": (
        "转写任务已经交给平台，但本机连续 {minutes} 分钟连不上平台，没拿到结果。先检查网络或代理；"
        "恢复后用同一个文件再调一次 media_transcribe，平台已经转完的话会直接取回结果。",
        "The transcription job reached the platform, but this computer could not reach the platform for "
        "{minutes} minutes in a row, so there is no result. Check the network or proxy; once it is back, call "
        "media_transcribe again with the same file, and a result the platform already finished comes straight back.",
    ),
    "asr_job_overdue": (
        "平台转写等了 {minutes} 分钟还没完成，这次停止等待。可以稍后用同一个文件再试一次；"
        "这段素材如果不需要台词，按没有字幕的素材继续。",
        "The platform has been transcribing for {minutes} minutes without finishing, so this wait stops here. "
        "Try again later with the same file; if this clip does not need its speech, carry on without captions.",
    ),
    "asr_job_lost": (
        "平台重启过，找不到这个转写任务；自动重新提交一次后又找不到了，这次没有结果。稍后用同一个文件再调一次 media_transcribe。",
        "The platform restarted and lost this transcription job, and the automatic resubmission was lost too; "
        "there is no result this time. Call media_transcribe again later with the same file.",
    ),
    # What the agent can do next when a video job's end is out of reach. The same call
    # again carries the same Idempotency-Key, so a clip the platform kept comes back.
    "video_job_unreachable": (
        "视频任务已经交给平台，但本机连续 {minutes} 分钟连不上平台，没拿到结果；平台那边可能还在生成。"
        "先检查网络或代理，恢复后用完全相同的参数再调一次 generate_video：平台还留着这个任务的话会直接取回，不会重新生成。",
        "The video job reached the platform, but this computer could not reach the platform for {minutes} "
        "minutes in a row, so there is no result; the platform may still be rendering it. Check the network or "
        "proxy; once it is back, call generate_video again with exactly the same arguments, and a job the "
        "platform still keeps comes straight back instead of rendering again.",
    ),
    "video_job_overdue": (
        "视频在平台上已经生成了 {minutes} 分钟还没完成(可能在排队),这次先停止等待。"
        "过几分钟用完全相同的参数再调一次 generate_video:平台还留着这个任务的话会接着等它、直接取回，不会重新生成。",
        "The video has been rendering on the platform for {minutes} minutes without finishing (it may be "
        "queued), so this wait stops here. In a few minutes call generate_video again with exactly the same "
        "arguments: a job the platform still keeps is picked up and returned, not rendered again.",
    ),
    "video_job_lost": (
        "平台重启过，找不到这个视频任务，这次没有结果。可以用同样的参数再调一次 generate_video。",
        "The platform restarted and lost this video job; there is no result this time. Call generate_video "
        "again with the same arguments.",
    ),
    "video_job_recovered": (
        "这是之前一次完全相同的调用已经生成好的视频(当时没取回),这次没有重新生成，也没有再计费。",
        "This is the video an earlier call with exactly the same arguments already generated (its answer never "
        "arrived); nothing was rendered or billed again.",
    ),
    # hc-1190: the same four for an image job.
    "image_job_unreachable": (
        "图片任务已经交给平台，但本机连续 {minutes} 分钟连不上平台，没拿到结果；平台那边可能还在出图。"
        "先检查网络或代理，恢复后用完全相同的参数再调一次 generate_image：平台还留着这个任务的话会直接取回，不会重新出图。",
        "The image job reached the platform, but this computer could not reach the platform for {minutes} "
        "minutes in a row, so there is no result; the platform may still be drawing it. Check the network or "
        "proxy; once it is back, call generate_image again with exactly the same arguments, and a job the "
        "platform still keeps comes straight back instead of drawing again.",
    ),
    "image_job_overdue": (
        "图片在平台上已经生成了 {minutes} 分钟还没完成(可能在排队),这次先停止等待。"
        "过几分钟用完全相同的参数再调一次 generate_image:平台还留着这个任务的话会接着等它、直接取回，不会重新出图。",
        "The image has been drawing on the platform for {minutes} minutes without finishing (it may be "
        "queued), so this wait stops here. In a few minutes call generate_image again with exactly the same "
        "arguments: a job the platform still keeps is picked up and returned, not drawn again.",
    ),
    "image_job_lost": (
        "平台重启过，找不到这个图片任务，这次没有结果。可以用同样的参数再调一次 generate_image。",
        "The platform restarted and lost this image job; there is no result this time. Call generate_image "
        "again with the same arguments.",
    ),
    "image_job_recovered": (
        "这是之前一次完全相同的调用已经生成好的图片(当时没取回),这次没有重新出图，也没有再计费。",
        "This is the image an earlier call with exactly the same arguments already generated (its answer never "
        "arrived); nothing was drawn or billed again.",
    ),
    "media_daily_limit": ("今天的{label}生成额度用完了，明天恢复。", "Today's {label} generation quota is used up; it comes back tomorrow."),
    "media_switched_off": (
        "平台现在暂时关闭了{label}生成，重新开放之前重试也不会成功。",
        "The platform has switched {label} generation off for now; retrying will not work until it is back.",
    ),
    "media_not_configured": (
        "平台还没有开通{label}生成服务，重试也不会成功。",
        "The platform has not set up {label} generation; retrying will not help.",
    ),
    "media_auth_failed": (
        "平台的{label}生成服务配置出了问题，要等平台修好才能用，重试也不会成功。",
        "The platform's {label} generation setup is broken and works again only once the platform "
        "fixes it; retrying will not help.",
    ),
    "media_no_reason": ("{label}生成服务出了问题，没有说明原因。", "The {label} generation service had a problem without saying why."),
    "media_no_reason_status": (
        "{label}生成服务出错了({status}),没有说明原因。",
        "The {label} generation service failed ({status}) without saying why.",
    ),
    "media_unreadable": (
        "{label}生成服务的回答读不出来，这次没有结果。",
        "The {label} generation service sent an answer that could not be read; there is no result this time.",
    ),
    "media_paused_model": (
        "这次用的{label}模型最近连续几次都没生成成功，平台先暂停了它，{when}；"
        "现在也可以换一个{label}模型。",
        "The {label} model for this call failed several times in a row and the platform paused it; "
        "{when}. You can also switch to another {label} model now.",
    ),
    "media_paused": (
        "{label}生成最近连续几次都没成功，平台先暂停了它，{when}。",
        "{Label} generation failed several times in a row and the platform paused it; {when}.",
    ),
    "when_minutes": ("大约 {minutes} 分钟后可以再试", "try again in about {minutes} minutes"),
    "when_later": ("过一会儿可以再试", "try again in a while"),
    "media_unreachable": ("无法连接{label}生成服务: {reason}", "Could not reach the {label} generation service: {reason}"),
    "media_not_object": ("generate_{media} 的参数必须是 JSON 对象。", "generate_{media} expects a JSON object argument."),
    "media_missing_prompt": ("请提供{label}描述", "Please describe the {label}."),
    "media_failed": ("{label}生成失败: {reason}", "{Label} generation failed: {reason}"),
    "media_setting_malformed": ("当前{label}模型设置格式无效", "The current {label} model setting is malformed"),
    "media_setting_unknown": ("当前{label}模型设置不是可用的模型", "The current {label} model setting is not an available model"),
    "media_setting_unreadable": ("无法读取当前{label}模型设置", "Could not read the current {label} model setting"),
    # Input images (参考图、首帧、首尾帧).
    "input_images_not_list": (
        "images 必须是列表，每一项是 {{source, role, kind}}。",
        "images must be a list of {{source, role, kind}} objects.",
    ),
    "input_image_source_missing": ("images 第 {index} 项没有 source。", "images item {index} has no source."),
    "input_images_unsupported_server": (
        "平台还不支持带图生成(参考图、首帧、首尾帧),这次没有生成。可以先不带图生成，或等平台更新后再试。",
        "The platform does not take input images (references, first or last frames) yet; nothing was "
        "generated. Generate without images for now, or try again after the platform updates.",
    ),
    "input_image_missing": (
        "找不到第 {index} 张图({source}),这次没有生成。请让用户重新发图，或用生成结果里的 image_ref。",
        "Image {index} ({source}) was not found; nothing was generated. Ask for the image again, or use "
        "the image_ref from an earlier result.",
    ),
    "input_image_too_large": (
        "第 {index} 张图超过 {mb} MB,没有上传，这次没有生成。",
        "Image {index} is over {mb} MB and was not uploaded; nothing was generated.",
    ),
    "input_image_download_failed": (
        "第 {index} 张图的链接下载不下来({reason}),这次没有生成。",
        "Image {index}'s link could not be downloaded ({reason}); nothing was generated.",
    ),
    "input_image_upload_failed": (
        "第 {index} 张图上传失败：{reason}。这次没有生成，也不会改成不带图去生成。",
        "Image {index} could not be uploaded: {reason}. Nothing was generated, and nothing will be "
        "generated without the image.",
    ),
}
