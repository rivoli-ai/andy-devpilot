FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/ .

# Install EF tools and create a migration bundle (self-contained binary)
RUN dotnet tool install --global dotnet-ef
ENV PATH="$PATH:/root/.dotnet/tools"

RUN dotnet publish API/DevPilot.API.csproj -c Release -o /app/publish

RUN dotnet ef migrations bundle \
    --project Infrastructure/DevPilot.Infrastructure.csproj \
    --startup-project API/DevPilot.API.csproj \
    --output /app/publish/efbundle \
    --self-contained \
    -r linux-x64 \
    --force

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app

COPY --from=build /app/publish .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh efbundle

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
