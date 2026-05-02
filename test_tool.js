
const axios = require('axios');

async function testAnalyze() {
    const track_id = 1; // Ajusta según tu DB
    const lat = 42.0; 
    const lng = 3.0;

    try {
        const response = await axios.post('http://localhost:10000/api/ai/command', {
            prompt: `Analyze point [${lng}, ${lat}] on track ${track_id}`,
            model: 'deepseek'
        }, {
            headers: {
                'Authorization': 'Bearer ' + process.env.ADMIN_KEY // Si adminAuth usara password, pero usa bypass
            }
        });
        console.log('Result:', JSON.stringify(response.data, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
    }
}

// testAnalyze();
console.log("Prueba manual recomendada: Iniciar server y enviar petición POST a /api/ai/command llamando a analyze_track_point.");
