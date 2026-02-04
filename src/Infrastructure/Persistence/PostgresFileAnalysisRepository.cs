namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of IFileAnalysisRepository using EF Core
/// </summary>
public class PostgresFileAnalysisRepository : IFileAnalysisRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresFileAnalysisRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<FileAnalysis?> GetByRepositoryAndPathAsync(Guid repositoryId, string filePath, string? branch = null, CancellationToken cancellationToken = default)
    {
        var query = _context.FileAnalyses.AsNoTracking()
            .Where(fa => fa.RepositoryId == repositoryId && fa.FilePath == filePath);
        
        if (!string.IsNullOrEmpty(branch))
        {
            query = query.Where(fa => fa.Branch == branch);
        }
        
        return await query.OrderByDescending(fa => fa.AnalyzedAt).FirstOrDefaultAsync(cancellationToken);
    }

    public async Task<IEnumerable<FileAnalysis>> GetByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        return await _context.FileAnalyses.AsNoTracking()
            .Where(fa => fa.RepositoryId == repositoryId)
            .OrderByDescending(fa => fa.AnalyzedAt)
            .ToListAsync(cancellationToken);
    }

    public async Task<FileAnalysis> AddAsync(FileAnalysis analysis, CancellationToken cancellationToken = default)
    {
        _context.FileAnalyses.Add(analysis);
        await _context.SaveChangesAsync(cancellationToken);
        return analysis;
    }

    public async System.Threading.Tasks.Task UpdateAsync(FileAnalysis analysis, CancellationToken cancellationToken = default)
    {
        _context.FileAnalyses.Update(analysis);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        var analyses = await _context.FileAnalyses.Where(fa => fa.RepositoryId == repositoryId).ToListAsync(cancellationToken);
        _context.FileAnalyses.RemoveRange(analyses);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteByRepositoryAndPathAsync(Guid repositoryId, string filePath, CancellationToken cancellationToken = default)
    {
        var analyses = await _context.FileAnalyses
            .Where(fa => fa.RepositoryId == repositoryId && fa.FilePath == filePath)
            .ToListAsync(cancellationToken);
        _context.FileAnalyses.RemoveRange(analyses);
        await _context.SaveChangesAsync(cancellationToken);
    }
}
