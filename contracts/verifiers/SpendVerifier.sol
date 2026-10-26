// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract SpendVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 1861351196105785899313237846888806120972129577884918293665849554700126667204;
    uint256 constant deltax2 = 15801512898880926414409300875865068854402215174713402880239929528431225443559;
    uint256 constant deltay1 = 15344482464461838523066001404440819554893105579062171647377679343679860405698;
    uint256 constant deltay2 = 18731073030902695654513324320736415486395617198248852676889224330280023033901;

    
    uint256 constant IC0x = 294353349763322940066323067373053098028255274501511793507280773124563122331;
    uint256 constant IC0y = 19799504835206869419314889534993602863941154758279450081095486710177735724315;
    
    uint256 constant IC1x = 9801959296289171282575471172529543906642695563019288602206177296828944670494;
    uint256 constant IC1y = 14400259865412500163507139505513412896391730175276288933440422730015413240341;
    
    uint256 constant IC2x = 7040981968778988163743807319513631963900323910747587799019639194369243392368;
    uint256 constant IC2y = 6184260954842830438899145795299537514805881827248244427033328507593681487326;
    
    uint256 constant IC3x = 3707422472531848921159825285876598320321430369658893885725799836852105946216;
    uint256 constant IC3y = 9140838772216120109085882726675016158370221318831303353087776367519787175740;
    
    uint256 constant IC4x = 18876209622738532276899914237137236674128383587579219865912097138891909466352;
    uint256 constant IC4y = 12135381546612904331433687346455059560793680587162012876765875914172303018648;
    
    uint256 constant IC5x = 2660720672496362030257115701647207580383979202261413244994223025716807789804;
    uint256 constant IC5y = 5292199441205405060409775849716535906312135397456687314865403418119370687548;
    
    uint256 constant IC6x = 11321349733812419745711396662810121732680518503515858080045174987655303387734;
    uint256 constant IC6y = 13110704363735383386371594682475196452794791474895518225602527130724660625658;
    
    uint256 constant IC7x = 13368623621301931920224317047378064416418964438364592142074880344087448014746;
    uint256 constant IC7y = 17025118151916771917360608350260329695848215964044584801359898433430012036885;
    
    uint256 constant IC8x = 13719602553462783097955718466476052290298309765239284164511845151794541657899;
    uint256 constant IC8y = 19690998095223169347159801115828388848657400273333929724807512707062718130948;
    
    uint256 constant IC9x = 2372600880865649855312889799748217881480545156713670513620586289659387747416;
    uint256 constant IC9y = 4884186637688238073790457498015133225502659493951827725406545410192648690752;
    
    uint256 constant IC10x = 4928352589795370017518374279851242068562509913006982798790103312869186910526;
    uint256 constant IC10y = 13003685425141972354309748472657551322733918256960899906638188430319578171661;
    
    uint256 constant IC11x = 20776740864005639257319748679484633664925000215803093495068441563193368771109;
    uint256 constant IC11y = 7582897668719596444213285281181590904494169306263671913796478290621736726144;
    
    uint256 constant IC12x = 19564388162456953755569730597695235171891633820301973489291571012101964849612;
    uint256 constant IC12y = 12298260522184387212913201317657196754023174468641396496684578116791573684396;
    
    uint256 constant IC13x = 13074519747232399496346638123904008970537614477150788795239295999420080731367;
    uint256 constant IC13y = 18378023881190118557798451619023196630798997375774147337476957140555248972250;
    
    uint256 constant IC14x = 6656931789111538853645226817393204456463236569395054442216568575947749239328;
    uint256 constant IC14y = 15855728855448557226609495587171281565168058106651806065916475817184882060487;
    
    uint256 constant IC15x = 983476280961853690436794177654253738344152000182405896590401851774965765561;
    uint256 constant IC15y = 18062331057720520866879282103555342508847293458925725929519680747724444945027;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
