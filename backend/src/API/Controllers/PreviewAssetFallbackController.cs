namespace DevPilot.API.Controllers;

using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Redirects root-absolute asset requests (e.g. <c>/styles.css</c>, <c>/runtime.js</c>,
/// <c>/manifest.json</c>) that originated from a preview page back through the
/// correct <c>/api/sandboxes/{id}/preview/{port}/…</c> route.
///
/// Why: Angular/Vite dev-server bundles use <c>&lt;base href=&quot;/&quot;&gt;</c> and
/// absolute script tags. Rewriting HTML alone is not enough because runtime
/// fetches (webpack publicPath, lazy chunks, XHR) still hit the backend root.
/// Using the <c>Referer</c> header lets us route those requests without
/// introducing cookies or per-sandbox subdomains.
///
/// Only root-absolute paths (<c>/foo</c>) with a preview <c>Referer</c> are
/// redirected; everything else falls through to a normal 404, so legitimate
/// API routes (<c>/api/*</c>, <c>/hubs/*</c>, <c>/health</c>) are unaffected.
/// </summary>
[ApiController]
[AllowAnonymous]
public sealed class PreviewAssetFallbackController : ControllerBase
{
    private static readonly Regex PreviewRefererRegex = new(
        "/api/sandboxes/(?<id>[^/?#]+)/preview/(?<port>\\d+)(?:/|$)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    [HttpGet("/{**path}")]
    [HttpHead("/{**path}")]
    public IActionResult Fallback(string? path)
    {
        if (string.IsNullOrEmpty(path)) return NotFound();

        // Never swallow the backend's own routes; they're all under /api/, /hubs/, /health.
        if (path.StartsWith("api/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("hubs/", StringComparison.OrdinalIgnoreCase)
            || path.Equals("health", StringComparison.OrdinalIgnoreCase))
        {
            return NotFound();
        }

        var referer = Request.Headers.Referer.ToString();
        if (string.IsNullOrEmpty(referer)) return NotFound();

        var match = PreviewRefererRegex.Match(referer);
        if (!match.Success) return NotFound();

        var sandboxId = match.Groups["id"].Value;
        var port = match.Groups["port"].Value;
        var query = Request.QueryString.HasValue ? Request.QueryString.Value : string.Empty;
        var target = $"/api/sandboxes/{sandboxId}/preview/{port}/{path}{query}";

        // 307 preserves method; browser retries through the normal preview route.
        return Redirect(target);
    }
}
