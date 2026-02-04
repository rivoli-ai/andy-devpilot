namespace DevPilot.API.Controllers;

using System.Security.Claims;
using DevPilot.Application.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Request body for file analysis
/// </summary>
public class AnalyzeFileRequest
{
    public required string FilePath { get; set; }
    public required string FileContent { get; set; }
    public string? Branch { get; set; }
}

/// <summary>
/// Request body for repository analysis (legacy - triggers backend sandbox)
/// </summary>
public class AnalyzeRepositoryRequest
{
    public string? Branch { get; set; }
}

/// <summary>
/// Request body for saving analysis results from frontend
/// </summary>
public class SaveAnalysisRequest
{
    public string? Branch { get; set; }
    public required string Summary { get; set; }
    public string? Architecture { get; set; }
    public string? KeyComponents { get; set; }
    public string? Dependencies { get; set; }
    public string? Recommendations { get; set; }
    public string? Model { get; set; }
}

/// <summary>
/// Controller for AI-powered code analysis
/// Supports both global repository analysis and per-file explanations
/// </summary>
[ApiController]
[Route("api/repositories/{repositoryId}/analysis")]
[Authorize]
public class CodeAnalysisController : ControllerBase
{
    private readonly ICodeAnalysisService _codeAnalysisService;
    private readonly ILogger<CodeAnalysisController> _logger;

    public CodeAnalysisController(
        ICodeAnalysisService codeAnalysisService,
        ILogger<CodeAnalysisController> logger)
    {
        _codeAnalysisService = codeAnalysisService ?? throw new ArgumentNullException(nameof(codeAnalysisService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Get stored code analysis for a repository
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetAnalysis(
        [FromRoute] Guid repositoryId,
        [FromQuery] string? branch,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await _codeAnalysisService.GetStoredAnalysisAsync(repositoryId, branch, cancellationToken);
            if (result == null)
            {
                return NotFound(new { message = "No analysis found for this repository" });
            }
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting analysis for repository {RepositoryId}", repositoryId);
            return StatusCode(500, new { message = "Failed to get analysis", error = ex.Message });
        }
    }

    /// <summary>
    /// Save code analysis results from frontend (frontend-driven sandbox flow)
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> SaveAnalysis(
        [FromRoute] Guid repositoryId,
        [FromBody] SaveAnalysisRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Saving analysis for repository {RepositoryId}", repositoryId);
            
            var result = await _codeAnalysisService.SaveAnalysisResultAsync(
                repositoryId,
                request.Branch,
                request.Summary,
                request.Architecture,
                request.KeyComponents,
                request.Dependencies,
                request.Recommendations,
                request.Model,
                cancellationToken);
            
            return Ok(result);
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("not found"))
        {
            return NotFound(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving analysis for repository {RepositoryId}", repositoryId);
            return StatusCode(500, new { message = "Failed to save analysis", error = ex.Message });
        }
    }

    /// <summary>
    /// Get stored file analysis
    /// </summary>
    [HttpGet("file")]
    public async Task<IActionResult> GetFileAnalysis(
        [FromRoute] Guid repositoryId,
        [FromQuery] string path,
        [FromQuery] string? branch,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(path))
        {
            return BadRequest(new { message = "File path is required" });
        }

        try
        {
            var result = await _codeAnalysisService.GetStoredFileAnalysisAsync(repositoryId, path, branch, cancellationToken);
            if (result == null)
            {
                return NotFound(new { message = "No analysis found for this file" });
            }
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting file analysis for {Path} in repository {RepositoryId}", path, repositoryId);
            return StatusCode(500, new { message = "Failed to get file analysis", error = ex.Message });
        }
    }

    /// <summary>
    /// Trigger a new file analysis
    /// Uses direct AI chat completion (no sandbox needed)
    /// </summary>
    [HttpPost("file")]
    public async Task<IActionResult> AnalyzeFile(
        [FromRoute] Guid repositoryId,
        [FromBody] AnalyzeFileRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(request.FilePath))
        {
            return BadRequest(new { message = "File path is required" });
        }

        if (string.IsNullOrEmpty(request.FileContent))
        {
            return BadRequest(new { message = "File content is required" });
        }

        var userIdClaim = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrEmpty(userIdClaim) || !Guid.TryParse(userIdClaim, out var userId))
        {
            return Unauthorized(new { message = "User ID not found in token" });
        }

        try
        {
            _logger.LogInformation("Starting file analysis for {FilePath} in repository {RepositoryId}", 
                request.FilePath, repositoryId);
            
            var result = await _codeAnalysisService.AnalyzeFileAsync(
                repositoryId,
                userId,
                request.FilePath,
                request.FileContent,
                request.Branch, 
                cancellationToken);
            
            return Ok(result);
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("not found"))
        {
            return NotFound(new { message = ex.Message });
        }
        catch (TimeoutException ex)
        {
            _logger.LogWarning(ex, "File analysis timeout for {FilePath} in repository {RepositoryId}", 
                request.FilePath, repositoryId);
            return StatusCode(504, new { message = "Analysis timed out", error = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error analyzing file {FilePath} in repository {RepositoryId}", 
                request.FilePath, repositoryId);
            return StatusCode(500, new { message = "Failed to analyze file", error = ex.Message });
        }
    }

    /// <summary>
    /// Delete all stored analysis for a repository (for refresh)
    /// </summary>
    [HttpDelete]
    public async Task<IActionResult> DeleteAnalysis(
        [FromRoute] Guid repositoryId,
        CancellationToken cancellationToken)
    {
        try
        {
            await _codeAnalysisService.DeleteAnalysisAsync(repositoryId, cancellationToken);
            return Ok(new { message = "Analysis deleted successfully" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting analysis for repository {RepositoryId}", repositoryId);
            return StatusCode(500, new { message = "Failed to delete analysis", error = ex.Message });
        }
    }
}
