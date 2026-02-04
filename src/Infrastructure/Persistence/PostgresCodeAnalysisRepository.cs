namespace DevPilot.Infrastructure.Persistence;

using DevPilot.Domain.Entities;
using DevPilot.Domain.Interfaces;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// PostgreSQL implementation of ICodeAnalysisRepository using EF Core
/// </summary>
public class PostgresCodeAnalysisRepository : ICodeAnalysisRepository
{
    private readonly DevPilotDbContext _context;

    public PostgresCodeAnalysisRepository(DevPilotDbContext context)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
    }

    public async Task<CodeAnalysis?> GetByRepositoryIdAsync(Guid repositoryId, string? branch = null, CancellationToken cancellationToken = default)
    {
        var query = _context.CodeAnalyses.AsNoTracking().Where(ca => ca.RepositoryId == repositoryId);
        
        if (!string.IsNullOrEmpty(branch))
        {
            query = query.Where(ca => ca.Branch == branch);
        }
        
        return await query.OrderByDescending(ca => ca.AnalyzedAt).FirstOrDefaultAsync(cancellationToken);
    }

    public async Task<CodeAnalysis> AddAsync(CodeAnalysis analysis, CancellationToken cancellationToken = default)
    {
        _context.CodeAnalyses.Add(analysis);
        await _context.SaveChangesAsync(cancellationToken);
        return analysis;
    }

    public async System.Threading.Tasks.Task UpdateAsync(CodeAnalysis analysis, CancellationToken cancellationToken = default)
    {
        _context.CodeAnalyses.Update(analysis);
        await _context.SaveChangesAsync(cancellationToken);
    }

    public async System.Threading.Tasks.Task DeleteByRepositoryIdAsync(Guid repositoryId, CancellationToken cancellationToken = default)
    {
        var analyses = await _context.CodeAnalyses.Where(ca => ca.RepositoryId == repositoryId).ToListAsync(cancellationToken);
        _context.CodeAnalyses.RemoveRange(analyses);
        await _context.SaveChangesAsync(cancellationToken);
    }
}
