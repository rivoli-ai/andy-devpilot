FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY manager.py k8s_utils.py cleanup.py ./

EXPOSE 8090

CMD ["python", "manager.py"]
