from flask import Flask, jsonify
from flask_cors import CORS
from monitor.sensors import collect_all_data

app = Flask(__name__)
CORS(app)

@app.route("/")
def home():
    return jsonify({"message": "Welcome to the AI Home Server API!"})

@app.route("/metrics")
def metrics():
    return jsonify(collect_all_data())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
